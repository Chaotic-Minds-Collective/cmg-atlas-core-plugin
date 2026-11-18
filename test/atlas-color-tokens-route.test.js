import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import Fastify from "fastify";
import { pool } from "../dist/db.js";
import { hashToken } from "../dist/auth/session.js";
import { hashServiceToken } from "../dist/auth/service.js";
import { registerAtlasColorTokenRoutes } from "../dist/routes/atlas-color-tokens.js";

test("ATLAS color-token applications reserve uses and consume only after adapter success", {
  skip: !pool ? "DATABASE_URL is not configured" : false
}, async (t) => {
  const app = Fastify();
  await registerAtlasColorTokenRoutes(app);

  const principalId = randomUUID();
  const serviceId = randomUUID();
  const wrongScopeServiceId = randomUUID();
  const clusterId = randomUUID();
  const serverId = randomUUID();
  const productId = randomUUID();
  const orderId = randomUUID();
  const orderItemId = randomUUID();
  const paymentId = randomUUID();
  const entitlementId = randomUUID();
  const gridId = "color-token-test-" + randomUUID();
  const steamId = "7656119" + String(randomInt(1_000_000_000, 9_999_999_999));
  const playerToken = randomBytes(32).toString("base64url");
  const serviceToken = "cg_srv_" + randomBytes(36).toString("base64url");
  const unassignedServiceToken = "cg_srv_" + randomBytes(36).toString("base64url");
  const wrongScopeServiceToken = "cg_srv_" + randomBytes(36).toString("base64url");
  const now = new Date();
  const applicationIds = [];
  const appKeys = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];

  try {
    await pool.query(
      "INSERT INTO core.principals (id, principal_type, status) VALUES ($1, 'user', 'active'), ($2, 'service', 'active'), ($3, 'service', 'active')",
      [principalId, serviceId, wrongScopeServiceId]
    );
    await pool.query(
      "INSERT INTO core.users (principal_id, username) VALUES ($1, $2)",
      [principalId, "ct-" + principalId.slice(0, 12)]
    );
    await pool.query(
      "INSERT INTO core.service_accounts (principal_id, application_name, description) VALUES ($1, $2, 'ATLAS color-token route test')",
      [serviceId, "color-token-test-" + serviceId]
    );
    await pool.query(
      "INSERT INTO core.service_accounts (principal_id, application_name, description) VALUES ($1, $2, 'Wrong-scope ATLAS test worker')",
      [wrongScopeServiceId, "color-token-wrong-scope-test-" + wrongScopeServiceId]
    );
    await pool.query(
      "INSERT INTO core.service_credentials (principal_id, credential_hash, label) VALUES ($1, $2, 'test credential')",
      [serviceId, hashServiceToken(serviceToken)]
    );
    await pool.query(
      "INSERT INTO core.service_credentials (principal_id, credential_hash, label) VALUES ($1, $2, 'wrong-scope test credential')",
      [wrongScopeServiceId, hashServiceToken(wrongScopeServiceToken)]
    );
    await pool.query(
      "INSERT INTO core.auth_sessions (principal_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 hour')",
      [principalId, hashToken(playerToken)]
    );
    await pool.query(
      "INSERT INTO core.linked_accounts (principal_id, provider, external_id, verified_at) VALUES ($1, 'steam', $2, NOW())",
      [principalId, steamId]
    );

    await pool.query(
      "INSERT INTO core.clusters (id, game_key, name, status) VALUES ($1, 'atlas', 'Color-token test cluster', 'active')",
      [clusterId]
    );
    await pool.query(
      "INSERT INTO core.servers (id, cluster_id, game_key, name, environment, status) VALUES ($1, $2, 'atlas', 'Color-token test server', 'test', 'offline')",
      [serverId, clusterId]
    );
    await pool.query(
      "INSERT INTO games_atlas.maps (cluster_id, server_id, map_key, display_name) VALUES ($1, $2, $3, 'Color-token test grid')",
      [clusterId, serverId, gridId]
    );
    await pool.query(
      "INSERT INTO core.principal_role_assignments (principal_id, role_id, scope_type, scope_id) SELECT $1, id, 'server', $2 FROM core.roles WHERE role_key = 'atlas_color_token_worker'",
      [serviceId, serverId]
    );
    await pool.query(
      "INSERT INTO core.principal_role_assignments (principal_id, role_id, scope_type, scope_id) SELECT $1, id, 'cluster', $2 FROM core.roles WHERE role_key = 'atlas_color_token_worker'",
      [wrongScopeServiceId, clusterId]
    );

    await pool.query(
      "INSERT INTO commerce.products (id, sku, name, product_type, status) VALUES ($1, $2, 'Ship Color Token Test', 'game_entitlement', 'active')",
      [productId, "test-color-token-" + productId]
    );
    await pool.query(
      "INSERT INTO commerce.atlas_color_token_products (product_id, token_kind) VALUES ($1, 'ship')",
      [productId]
    );
    await pool.query(
      `INSERT INTO commerce.orders
        (id, principal_id, status, currency, subtotal_minor, tax_minor, total_minor, idempotency_key, created_at)
       VALUES ($1, $2, 'paid', 'USD', 300, 0, 300, $3, $4)`,
      [orderId, principalId, "color-token-order-" + orderId, now]
    );
    await pool.query(
      `INSERT INTO commerce.order_items
        (id, order_id, product_id, sku_snapshot, name_snapshot, quantity, unit_amount_minor, line_total_minor)
       VALUES ($1, $2, $3, $4, 'Ship Color Token Test', 3, 100, 300)`,
      [orderItemId, orderId, productId, "test-color-token-" + productId]
    );
    await pool.query(
      `INSERT INTO commerce.payment_transactions
        (id, order_id, provider, provider_transaction_id, provider_event_id, status, amount_minor, currency, verified_at, created_at)
       VALUES ($1, $2, 'stripe', $3, $4, 'succeeded', 300, 'USD', $5, $5)`,
      [paymentId, orderId, "stripe-color-token-" + paymentId, "stripe-color-token-event-" + paymentId, now]
    );
    await pool.query(
      "INSERT INTO commerce.entitlements (id, principal_id, product_id, order_item_id, quantity, status, granted_at) VALUES ($1, $2, $3, $4, 3, 'active', $5)",
      [entitlementId, principalId, productId, orderItemId, now]
    );

    const payload = {
      entitlementId,
      assetId: "ship-" + randomUUID(),
      scope: { serverId, clusterId, gridId },
      selectedColor: { opaqueAdapterValue: ["test", 17, true] }
    };
    const submit = (key, body = payload) => app.inject({
      method: "POST",
      url: "/account/atlas/color-token-applications",
      headers: { authorization: "Bearer " + playerToken, "idempotency-key": key },
      payload: body
    });
    const ack = (applicationId, leaseToken, outcome, errorCode) => app.inject({
      method: "POST",
      url: `/integrations/servers/${serverId}/atlas/color-token-applications/${applicationId}/ack`,
      headers: { authorization: "Bearer " + serviceToken },
      payload: { leaseToken, outcome, ...(errorCode ? { errorCode } : {}) }
    });

    const unverifiedPayment = await pool.query(
      "UPDATE commerce.payment_transactions SET verified_at = NULL WHERE id = $1",
      [paymentId]
    );
    assert.equal(unverifiedPayment.rowCount, 1);
    const unpaid = await submit("unverified-" + randomUUID());
    assert.equal(unpaid.statusCode, 409);
    assert.equal(unpaid.json().error.code, "ACTIVE_PAID_COLOR_TOKEN_REQUIRED");
    await pool.query("UPDATE commerce.payment_transactions SET verified_at = $2 WHERE id = $1", [paymentId, now]);

    const invalidOwner = await submit("invalid-owner-" + randomUUID(), { ...payload, ownerExternalId: steamId });
    assert.equal(invalidOwner.statusCode, 400);

    const oversizedColor = await submit("oversized-color-" + randomUUID(), { ...payload, selectedColor: "x".repeat(4097) });
    assert.equal(oversizedColor.statusCode, 400);

    const wrongScope = await submit("wrong-scope-" + randomUUID(), {
      ...payload,
      scope: { ...payload.scope, gridId: "unregistered-grid" }
    });
    assert.equal(wrongScope.statusCode, 409);
    assert.equal(wrongScope.json().error.code, "COLOR_TOKEN_SCOPE_MISMATCH");

    const firstKey = "color-" + appKeys[0];
    const submissions = await Promise.all([submit(firstKey), submit(firstKey)]);
    assert.deepEqual(submissions.map((response) => response.statusCode).sort(), [200, 202]);
    const created = submissions.find((response) => response.statusCode === 202);
    const duplicate = submissions.find((response) => response.statusCode === 200);
    assert.ok(created);
    assert.ok(duplicate);
    const first = created.json().data;
    applicationIds.push(first.applicationId);
    assert.equal(first.status, "pending");
    assert.equal(first.tokenKind, "ship");
    assert.equal(duplicate.json().data.applicationId, first.applicationId);
    assert.equal(duplicate.json().data.duplicate, true);

    const idempotencyConflict = await submit(firstKey, {
      ...payload,
      selectedColor: { different: true }
    });
    assert.equal(idempotencyConflict.statusCode, 409);
    assert.equal(idempotencyConflict.json().error.code, "IDEMPOTENCY_CONFLICT");

    const secondResponse = await submit("color-" + appKeys[1], {
      ...payload,
      assetId: "ship-" + randomUUID()
    });
    const thirdResponse = await submit("color-" + appKeys[2], {
      ...payload,
      assetId: "ship-" + randomUUID()
    });
    assert.equal(secondResponse.statusCode, 202);
    assert.equal(thirdResponse.statusCode, 202);
    const second = secondResponse.json().data;
    const third = thirdResponse.json().data;
    applicationIds.push(second.applicationId, third.applicationId);

    const exhausted = await submit("color-" + appKeys[3], {
      ...payload,
      assetId: "ship-" + randomUUID()
    });
    assert.equal(exhausted.statusCode, 409);
    assert.equal(exhausted.json().error.code, "COLOR_TOKEN_EXHAUSTED");

    const forbiddenClaim = await app.inject({
      method: "POST",
      url: `/integrations/servers/${serverId}/atlas/color-token-applications/claim`,
      headers: { authorization: "Bearer " + unassignedServiceToken },
      payload: { limit: 20 }
    });
    assert.equal(forbiddenClaim.statusCode, 403);

    const wrongScopeClaim = await app.inject({
      method: "POST",
      url: `/integrations/servers/${serverId}/atlas/color-token-applications/claim`,
      headers: { authorization: "Bearer " + wrongScopeServiceToken },
      payload: { limit: 20 }
    });
    assert.equal(wrongScopeClaim.statusCode, 403);

    const claimedResponse = await app.inject({
      method: "POST",
      url: `/integrations/servers/${serverId}/atlas/color-token-applications/claim`,
      headers: { authorization: "Bearer " + serviceToken },
      payload: { limit: 20 }
    });
    assert.equal(claimedResponse.statusCode, 200);
    const claimed = claimedResponse.json().data;
    assert.equal(claimed.length, 3);
    const firstClaim = claimed.find((item) => item.applicationId === first.applicationId);
    const secondClaim = claimed.find((item) => item.applicationId === second.applicationId);
    const thirdClaim = claimed.find((item) => item.applicationId === third.applicationId);
    assert.ok(firstClaim && secondClaim && thirdClaim);
    assert.equal(firstClaim.tokenKind, "ship");
    assert.equal(firstClaim.ownerExternalId, steamId);
    assert.deepEqual(firstClaim.selectedColor, payload.selectedColor);

    await pool.query(
      "UPDATE operations.atlas_color_token_applications SET lease_expires_at = clock_timestamp() - INTERVAL '1 second' WHERE id = $1",
      [first.applicationId]
    );
    const reclaimedResponse = await app.inject({
      method: "POST",
      url: `/integrations/servers/${serverId}/atlas/color-token-applications/claim`,
      headers: { authorization: "Bearer " + serviceToken },
      payload: { limit: 1 }
    });
    assert.equal(reclaimedResponse.statusCode, 200);
    const reclaimed = reclaimedResponse.json().data[0];
    assert.equal(reclaimed.applicationId, first.applicationId);
    assert.notEqual(reclaimed.leaseToken, firstClaim.leaseToken);

    const staleAck = await ack(first.applicationId, firstClaim.leaseToken, "failed", "COLOR_UNSUPPORTED");
    assert.equal(staleAck.statusCode, 409);
    assert.equal(staleAck.json().error.code, "COLOR_TOKEN_LEASE_INVALID");

    const unsupportedColor = await ack(first.applicationId, reclaimed.leaseToken, "failed", "COLOR_UNSUPPORTED");
    assert.equal(unsupportedColor.statusCode, 202);
    assert.equal(unsupportedColor.json().data.status, "failed");

    const unauthorizedTarget = await ack(second.applicationId, secondClaim.leaseToken, "failed", "TARGET_NOT_AUTHORIZED");
    assert.equal(unauthorizedTarget.statusCode, 202);
    assert.equal(unauthorizedTarget.json().data.status, "failed");

    const applied = await ack(third.applicationId, thirdClaim.leaseToken, "applied");
    assert.equal(applied.statusCode, 202);
    assert.equal(applied.json().data.status, "applied");

    const repeatedAppliedAck = await ack(third.applicationId, thirdClaim.leaseToken, "applied");
    assert.equal(repeatedAppliedAck.statusCode, 200);
    assert.equal(repeatedAppliedAck.json().data.duplicate, true);

    const status = await app.inject({
      method: "GET",
      url: `/account/atlas/color-token-applications/${third.applicationId}`,
      headers: { authorization: "Bearer " + playerToken }
    });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().data.status, "applied");
    assert.deepEqual(status.json().data.selectedColor, payload.selectedColor);

    const fourthResponse = await submit("color-" + appKeys[3], {
      ...payload,
      assetId: "ship-" + randomUUID()
    });
    const fifthResponse = await submit("color-" + appKeys[4], {
      ...payload,
      assetId: "ship-" + randomUUID()
    });
    assert.equal(fourthResponse.statusCode, 202);
    assert.equal(fifthResponse.statusCode, 202);
    applicationIds.push(fourthResponse.json().data.applicationId, fifthResponse.json().data.applicationId);

    const noRemainingUses = await submit("color-" + randomUUID(), {
      ...payload,
      assetId: "ship-" + randomUUID()
    });
    assert.equal(noRemainingUses.statusCode, 409);
    assert.equal(noRemainingUses.json().error.code, "COLOR_TOKEN_EXHAUSTED");

    const audit = await pool.query(
      `SELECT action, outcome
         FROM operations.audit_logs
        WHERE resource_id = $1
          AND action IN ('atlas.color_token.application.applied', 'atlas.color_token.application.failed')
        ORDER BY action`,
      [third.applicationId]
    );
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0]?.action, "atlas.color_token.application.applied");
    assert.equal(audit.rows[0]?.outcome, "success");
  } finally {
    await pool.query(
      "DELETE FROM operations.audit_logs WHERE actor_principal_id = ANY($1::uuid[]) OR resource_id = ANY($2::text[])",
      [[principalId, serviceId, wrongScopeServiceId], applicationIds]
    );
    await pool.query("DELETE FROM operations.atlas_color_token_applications WHERE principal_id = $1", [principalId]);
    await pool.query("DELETE FROM commerce.entitlements WHERE id = $1", [entitlementId]);
    await pool.query("DELETE FROM commerce.payment_transactions WHERE id = $1", [paymentId]);
    await pool.query("DELETE FROM commerce.order_items WHERE id = $1", [orderItemId]);
    await pool.query("DELETE FROM commerce.orders WHERE id = $1", [orderId]);
    await pool.query("DELETE FROM commerce.atlas_color_token_products WHERE product_id = $1", [productId]);
    await pool.query("DELETE FROM commerce.products WHERE id = $1", [productId]);
    await pool.query("DELETE FROM games_atlas.maps WHERE server_id = $1", [serverId]);
    await pool.query("DELETE FROM core.servers WHERE id = $1", [serverId]);
    await pool.query("DELETE FROM core.clusters WHERE id = $1", [clusterId]);
    await pool.query("DELETE FROM core.auth_sessions WHERE principal_id = $1", [principalId]);
    await pool.query("DELETE FROM core.linked_accounts WHERE principal_id = $1", [principalId]);
    await pool.query("DELETE FROM core.principal_role_assignments WHERE principal_id = ANY($1::uuid[])", [[serviceId, wrongScopeServiceId]]);
    await pool.query("DELETE FROM core.service_credentials WHERE principal_id = ANY($1::uuid[])", [[serviceId, wrongScopeServiceId]]);
    await pool.query("DELETE FROM core.service_accounts WHERE principal_id = ANY($1::uuid[])", [[serviceId, wrongScopeServiceId]]);
    await pool.query("DELETE FROM core.users WHERE principal_id = $1", [principalId]);
    await pool.query("DELETE FROM core.principals WHERE id = ANY($1::uuid[])", [[principalId, serviceId, wrongScopeServiceId]]);
    await app.close();
  }
});
