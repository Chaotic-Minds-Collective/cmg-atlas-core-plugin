import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import Fastify from "fastify";
import { pool } from "../dist/db.js";
import { hashToken } from "../dist/auth/session.js";
import { registerAtlasInsuranceRoutes } from "../dist/routes/atlas-insurance.js";

test("ATLAS insurance claims require evidence and platform-admin approval", {
  skip: !pool ? "DATABASE_URL is not configured" : false
}, async (t) => {
  const app = Fastify();
  await registerAtlasInsuranceRoutes(app);

  const principalId = randomUUID();
  const adminId = randomUUID();
  const clusterId = randomUUID();
  const serverId = randomUUID();
  const productId = randomUUID();
  const orderId = randomUUID();
  const orderItemId = randomUUID();
  const paymentId = randomUUID();
  const entitlementId = randomUUID();
  const gridId = "insurance-test-" + randomUUID();
  const assetId = "tame-" + randomUUID();
  const steamId = "76561198000000001";
  const lossEventId = "loss-" + randomUUID();
  const snapshotId = randomUUID();
  const claimKey = "claim-" + randomUUID();
  const playerToken = randomBytes(32).toString("base64url");
  const adminToken = randomBytes(32).toString("base64url");
  const lossAt = new Date(Date.now() - 60 * 60 * 1000);
  const snapshotAt = new Date(lossAt.getTime() - 60 * 60 * 1000);
  const grantedAt = new Date(lossAt.getTime() - 24 * 60 * 60 * 1000);
  const paymentVerifiedAt = new Date(grantedAt.getTime() + 60 * 1000);
  const entitlementGrantedAt = new Date(grantedAt.getTime() + 2 * 60 * 1000);

  try {
    for (const id of [principalId, adminId]) {
      await pool.query(
        "INSERT INTO core.principals (id, principal_type, status) VALUES ($1, 'user', 'active')",
        [id]
      );
      await pool.query(
        "INSERT INTO core.users (principal_id, username) VALUES ($1, $2)",
        [id, "insurance-" + id]
      );
    }

    await pool.query(
      "INSERT INTO core.auth_sessions (principal_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 hour'), ($3, $4, NOW() + INTERVAL '1 hour')",
      [principalId, hashToken(playerToken), adminId, hashToken(adminToken)]
    );
    await pool.query(
      "INSERT INTO core.linked_accounts (principal_id, provider, external_id, verified_at) VALUES ($1, 'steam', $2, NOW())",
      [principalId, steamId]
    );
    await pool.query(
      "INSERT INTO core.principal_role_assignments (principal_id, role_id, scope_type, scope_id) SELECT $1, id, 'platform', NULL FROM core.roles WHERE role_key = 'platform_admin'",
      [adminId]
    );

    await pool.query(
      "INSERT INTO commerce.products (id, sku, name, product_type, status) VALUES ($1, $2, 'Tame Insurance Test', 'game_entitlement', 'active')",
      [productId, "test-insurance-" + productId]
    );
    await pool.query(
      "INSERT INTO commerce.atlas_insurance_products (product_id, asset_kind, coverage_seconds) VALUES ($1, 'tame', 604800)",
      [productId]
    );
    await pool.query(
      `INSERT INTO commerce.orders
        (id, principal_id, status, currency, subtotal_minor, tax_minor, total_minor, idempotency_key, created_at)
       VALUES ($1, $2, 'paid', 'USD', 100, 0, 100, $3, $4)`,
      [orderId, principalId, "insurance-order-" + orderId, grantedAt]
    );
    await pool.query(
      `INSERT INTO commerce.order_items
        (id, order_id, product_id, sku_snapshot, name_snapshot, quantity, unit_amount_minor, line_total_minor)
       VALUES ($1, $2, $3, $4, 'Tame Insurance Test', 1, 100, 100)`,
      [orderItemId, orderId, productId, "test-insurance-" + productId]
    );
    await pool.query(
      `INSERT INTO commerce.payment_transactions
        (id, order_id, provider, provider_transaction_id, provider_event_id, status, amount_minor, currency, verified_at, created_at)
       VALUES ($1, $2, 'stripe', $3, $4, 'succeeded', 100, 'USD', $5, $5)`,
      [paymentId, orderId, "stripe-test-" + paymentId, "stripe-event-" + paymentId, paymentVerifiedAt]
    );
    await pool.query(
      "INSERT INTO commerce.entitlements (id, principal_id, product_id, order_item_id, quantity, status, granted_at) VALUES ($1, $2, $3, $4, 1, 'active', $5)",
      [entitlementId, principalId, productId, orderItemId, entitlementGrantedAt]
    );

    await pool.query(
      "INSERT INTO core.clusters (id, game_key, name, status) VALUES ($1, 'atlas', 'Insurance test cluster', 'active')",
      [clusterId]
    );
    await pool.query(
      "INSERT INTO core.servers (id, cluster_id, game_key, name, environment, status) VALUES ($1, $2, 'atlas', 'Insurance test server', 'test', 'offline')",
      [serverId, clusterId]
    );
    await pool.query(
      "INSERT INTO games_atlas.maps (cluster_id, server_id, map_key, display_name) VALUES ($1, $2, $3, 'Insurance test grid')",
      [clusterId, serverId, gridId]
    );
    await pool.query(
      `INSERT INTO operations.game_events
        (server_id, cluster_id, grid_id, game_key, external_event_id, event_type, payload, occurred_at)
       VALUES ($1, $2, $3, 'atlas', $4, 'tame.died', $5::jsonb, $6)`,
      [serverId, clusterId, gridId, lossEventId, JSON.stringify({ assetId, ownerId: steamId }), lossAt]
    );
    await pool.query(
      `INSERT INTO operations.asset_snapshots
        (snapshot_id, server_id, cluster_id, grid_id, kind, asset_id, owner_id,
         captured_at, reason, schema_version, encryption_algorithm, encryption_key_id,
         nonce, auth_tag, ciphertext, ciphertext_bytes, state_bytes)
       VALUES ($1, $2, $3, $4, 'tame', $5, $6, $7, 'pre-loss', 1, 'AES-256-GCM',
               $8, $9, $10, $11, 32, 22)`,
      [snapshotId, serverId, clusterId, gridId, assetId, steamId, snapshotAt,
        "test-key-" + snapshotId, randomBytes(12), randomBytes(16), randomBytes(32)]
    );

    const payload = {
      assetKind: "tame",
      assetId,
      lossEventId,
      scope: { serverId, clusterId, gridId }
    };
    const submit = () => app.inject({
      method: "POST",
      url: "/account/atlas/insurance/claims",
      headers: { authorization: "Bearer " + playerToken, "idempotency-key": claimKey },
      payload
    });

    const created = await submit();
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().data.status, "submitted");
    assert.equal(created.json().data.snapshotId, snapshotId);

    const duplicate = await submit();
    assert.equal(duplicate.statusCode, 200);
    assert.equal(duplicate.json().data.duplicate, true);
    assert.equal(duplicate.json().data.claimId, created.json().data.claimId);

    const playerReview = await app.inject({
      method: "GET",
      url: "/admin/atlas/insurance/claims",
      headers: { authorization: "Bearer " + playerToken }
    });
    assert.equal(playerReview.statusCode, 403);

    const adminReview = await app.inject({
      method: "GET",
      url: "/admin/atlas/insurance/claims",
      headers: { authorization: "Bearer " + adminToken }
    });
    assert.equal(adminReview.statusCode, 200);
    assert.equal(adminReview.json().data.length, 1);

    const claimId = created.json().data.claimId;
    const decision = () => app.inject({
      method: "POST",
      url: `/admin/atlas/insurance/claims/${claimId}/decision`,
      headers: { authorization: "Bearer " + adminToken },
      payload: { decision: "approve", note: "Test evidence reviewed" }
    });
    const approved = await decision();
    assert.equal(approved.statusCode, 202);
    assert.equal(approved.json().data.status, "approved");

    const repeatedApproval = await decision();
    assert.equal(repeatedApproval.statusCode, 200);
    assert.equal(repeatedApproval.json().data.duplicate, true);

    const outbox = await pool.query(
      "SELECT COUNT(*)::integer AS count FROM operations.event_outbox WHERE aggregate_type = 'atlas_insurance_claim' AND aggregate_id = $1 AND event_type = 'atlas.insurance.recovery.authorized'",
      [claimId]
    );
    assert.equal(outbox.rows[0]?.count, 1);
  } finally {
    await pool.query("DELETE FROM operations.event_outbox WHERE aggregate_type = 'atlas_insurance_claim' AND aggregate_id IN (SELECT id::text FROM operations.atlas_insurance_claims WHERE principal_id = ANY($1::uuid[]))", [[principalId]]);
    await pool.query("DELETE FROM operations.audit_logs WHERE actor_principal_id = ANY($1::uuid[])", [[principalId, adminId]]);
    await pool.query("DELETE FROM operations.atlas_insurance_claims WHERE principal_id = $1", [principalId]);
    await pool.query("DELETE FROM operations.asset_snapshots WHERE snapshot_id = $1", [snapshotId]);
    await pool.query("DELETE FROM operations.game_events WHERE server_id = $1 AND external_event_id = $2", [serverId, lossEventId]);
    await pool.query("DELETE FROM commerce.entitlements WHERE id = $1", [entitlementId]);
    await pool.query("DELETE FROM commerce.payment_transactions WHERE id = $1", [paymentId]);
    await pool.query("DELETE FROM commerce.order_items WHERE id = $1", [orderItemId]);
    await pool.query("DELETE FROM commerce.orders WHERE id = $1", [orderId]);
    await pool.query("DELETE FROM commerce.atlas_insurance_products WHERE product_id = $1", [productId]);
    await pool.query("DELETE FROM commerce.products WHERE id = $1", [productId]);
    await pool.query("DELETE FROM games_atlas.maps WHERE server_id = $1", [serverId]);
    await pool.query("DELETE FROM core.servers WHERE id = $1", [serverId]);
    await pool.query("DELETE FROM core.clusters WHERE id = $1", [clusterId]);
    await pool.query("DELETE FROM core.auth_sessions WHERE principal_id = ANY($1::uuid[])", [[principalId, adminId]]);
    await pool.query("DELETE FROM core.linked_accounts WHERE principal_id = $1", [principalId]);
    await pool.query("DELETE FROM core.principal_role_assignments WHERE principal_id = $1", [adminId]);
    await pool.query("DELETE FROM core.users WHERE principal_id = ANY($1::uuid[])", [[principalId, adminId]]);
    await pool.query("DELETE FROM core.principals WHERE id = ANY($1::uuid[])", [[principalId, adminId]]);
    await app.close();
  }
});
