import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import Fastify from "fastify";
import { pool } from "../dist/db.js";
import { hashServiceToken } from "../dist/auth/service.js";
import { hashToken } from "../dist/auth/session.js";
import { registerCommerceRoutes } from "../dist/routes/commerce.js";
import { registerRewardRoutes } from "../dist/routes/rewards.js";

test("reward lease renewal is fenced, scoped, and extends only an active claim", {
  skip: !pool ? "DATABASE_URL is not configured" : false
}, async () => {
  const app = Fastify();
  await registerRewardRoutes(app);
  await registerCommerceRoutes(app);
  const ids = {
    worker: randomUUID(),
    player: randomUUID(),
    admin: randomUUID(),
    cluster: randomUUID(),
    server: randomUUID(),
    product: randomUUID(),
    entitlement: randomUUID()
  };
  const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
  const token = "cg_srv_" + randomBytes(36).toString("base64url");
  const adminToken = randomBytes(32).toString("base64url");
  const rewardKey = "reward-renew-" + suffix;
  let rewardId;

  try {
    await pool.query(
      "INSERT INTO core.principals (id, principal_type, status) VALUES ($1, 'service', 'active'), ($2, 'user', 'active'), ($3, 'user', 'active')",
      [ids.worker, ids.player, ids.admin]
    );
    await pool.query(
      "INSERT INTO core.service_accounts (principal_id, application_name) VALUES ($1, $2)",
      [ids.worker, "reward-renew-test-" + suffix]
    );
    await pool.query(
      "INSERT INTO core.service_credentials (principal_id, credential_hash, label) VALUES ($1, $2, 'test')",
      [ids.worker, hashServiceToken(token)]
    );
    await pool.query(
      "INSERT INTO core.users (principal_id, username) VALUES ($1, $2), ($3, $4)",
      [ids.player, "reward_renew_" + suffix, ids.admin, "reward_admin_" + suffix]
    );
    await pool.query(
      "INSERT INTO core.auth_sessions (principal_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 hour')",
      [ids.admin, hashToken(adminToken)]
    );
    await pool.query(
      "INSERT INTO core.principal_role_assignments (principal_id, role_id, scope_type, scope_id) SELECT $1, id, 'platform', NULL FROM core.roles WHERE role_key = 'platform_admin'",
      [ids.admin]
    );
    await pool.query(
      "INSERT INTO core.clusters (id, game_key, name, status) VALUES ($1, 'atlas', $2, 'active')",
      [ids.cluster, "Reward renew test " + suffix]
    );
    await pool.query(
      "INSERT INTO core.servers (id, cluster_id, game_key, name, environment, status) VALUES ($1, $2, 'atlas', $3, 'test', 'offline')",
      [ids.server, ids.cluster, "Reward renew server " + suffix]
    );
    await pool.query(
      `INSERT INTO core.principal_role_assignments (principal_id, role_id, scope_type, scope_id)
       SELECT $1, id, 'server', $2 FROM core.roles WHERE role_key = 'reward_worker'`,
      [ids.worker, ids.server]
    );
    await pool.query(
      "INSERT INTO commerce.products (id, sku, name, product_type, status) VALUES ($1, $2, 'Reward renewal test', 'game_entitlement', 'active')",
      [ids.product, "reward-renew-" + suffix]
    );
    await pool.query(
      "INSERT INTO commerce.entitlements (id, principal_id, product_id, status) VALUES ($1, $2, $3, 'active')",
      [ids.entitlement, ids.player, ids.product]
    );
    const inserted = await pool.query(
      `INSERT INTO commerce.reward_queue
        (entitlement_id, game_key, server_id, target_external_id, delivery_payload, idempotency_key)
       VALUES ($1, 'atlas', $2, '76561198000000001', '{"itemKey":"test-item","quantity":1}'::jsonb, $3)
       RETURNING id`,
      [ids.entitlement, ids.server, rewardKey]
    );
    rewardId = inserted.rows[0].id;

    const headers = { authorization: "Bearer " + token };
    const claim = await app.inject({
      method: "POST",
      url: "/integrations/servers/" + ids.server + "/rewards/claim",
      headers,
      payload: { limit: 1, leaseSeconds: 30 }
    });
    assert.equal(claim.statusCode, 200, claim.body);
    const claimed = claim.json().data[0];
    assert.equal(claimed.id, rewardId);
    assert.ok(claimed.leaseToken);
    const originalExpiry = Date.parse(claimed.leaseExpiresAt);

    const renewed = await app.inject({
      method: "POST",
      url: "/integrations/servers/" + ids.server + "/rewards/" + rewardId + "/renew",
      headers,
      payload: { leaseToken: claimed.leaseToken, leaseSeconds: 120 }
    });
    assert.equal(renewed.statusCode, 200, renewed.body);
    assert.equal(renewed.json().data.renewed, true);
    assert.equal(renewed.json().data.rewardId, rewardId);
    assert.ok(Date.parse(renewed.json().data.leaseExpiresAt) > originalExpiry);

    const staleToken = await app.inject({
      method: "POST",
      url: "/integrations/servers/" + ids.server + "/rewards/" + rewardId + "/renew",
      headers,
      payload: { leaseToken: randomUUID(), leaseSeconds: 120 }
    });
    assert.equal(staleToken.statusCode, 409);
    assert.equal(staleToken.json().error.code, "REWARD_LEASE_INVALID");

    await pool.query("UPDATE commerce.reward_queue SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1", [rewardId]);
    const expired = await app.inject({
      method: "POST",
      url: "/integrations/servers/" + ids.server + "/rewards/" + rewardId + "/renew",
      headers,
      payload: { leaseToken: claimed.leaseToken, leaseSeconds: 120 }
    });
    assert.equal(expired.statusCode, 409);
    assert.equal(expired.json().error.code, "REWARD_LEASE_INVALID");

    const reclaimed = await app.inject({
      method: "POST",
      url: "/integrations/servers/" + ids.server + "/rewards/claim",
      headers,
      payload: { limit: 1, leaseSeconds: 30 }
    });
    assert.equal(reclaimed.statusCode, 200, reclaimed.body);
    const reclaimedReward = reclaimed.json().data[0];
    assert.notEqual(reclaimedReward.leaseToken, claimed.leaseToken);

    const manualReview = await app.inject({
      method: "POST",
      url: "/integrations/servers/" + ids.server + "/rewards/" + rewardId + "/ack",
      headers,
      payload: { leaseToken: reclaimedReward.leaseToken, outcome: "manual_review", error: "MANUAL_REVIEW_REQUIRED: item grant result is uncertain." }
    });
    assert.equal(manualReview.statusCode, 202, manualReview.body);
    assert.equal(manualReview.json().data.outcome, "manual_review");

    const adminResolution = await app.inject({
      method: "POST",
      url: "/admin/commerce/rewards/" + rewardId + "/reconcile",
      headers: { authorization: "Bearer " + adminToken },
      payload: { resolution: "retry", note: "Verified that the item marker is absent and no grant occurred." }
    });
    assert.equal(adminResolution.statusCode, 200, adminResolution.body);
    assert.equal(adminResolution.json().data.status, "failed");

    const finalState = await pool.query("SELECT status, idempotency_key FROM commerce.reward_queue WHERE id = $1", [rewardId]);
    assert.equal(finalState.rows[0].status, "failed");
    assert.notEqual(finalState.rows[0].idempotency_key, rewardKey);
  } finally {
    if (rewardId) {
      await pool.query("DELETE FROM commerce.reward_attempts WHERE reward_id = $1", [rewardId]);
      await pool.query("DELETE FROM commerce.reward_queue WHERE id = $1", [rewardId]);
    }
    await pool.query("DELETE FROM operations.audit_logs WHERE actor_principal_id = ANY($1::uuid[]) OR resource_id = ANY($2::text[])", [[ids.worker, ids.admin], [ids.server, rewardId].filter(Boolean)]);
    await pool.query("DELETE FROM commerce.entitlements WHERE id = $1", [ids.entitlement]);
    await pool.query("DELETE FROM commerce.products WHERE id = $1", [ids.product]);
    await pool.query("DELETE FROM core.principal_role_assignments WHERE principal_id = $1", [ids.worker]);
    await pool.query("DELETE FROM core.service_credentials WHERE principal_id = $1", [ids.worker]);
    await pool.query("DELETE FROM core.service_accounts WHERE principal_id = $1", [ids.worker]);
    await pool.query("DELETE FROM core.auth_sessions WHERE principal_id = $1", [ids.admin]);
    await pool.query("DELETE FROM core.principal_role_assignments WHERE principal_id = $1", [ids.admin]);
    await pool.query("DELETE FROM core.users WHERE principal_id = ANY($1::uuid[])", [[ids.player, ids.admin]]);
    await pool.query("DELETE FROM core.principals WHERE id = ANY($1::uuid[])", [[ids.worker, ids.player, ids.admin]]);
    await pool.query("DELETE FROM core.servers WHERE id = $1", [ids.server]);
    await pool.query("DELETE FROM core.clusters WHERE id = $1", [ids.cluster]);
    await app.close();
  }
});
