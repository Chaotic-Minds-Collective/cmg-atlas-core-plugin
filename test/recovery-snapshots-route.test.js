import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import Fastify from "fastify";
import { pool } from "../dist/db.js";
import { hashServiceToken } from "../dist/auth/service.js";
import { registerRecoverySnapshotRoutes } from "../dist/routes/recovery-snapshots.js";

test("ATLAS recovery snapshots persist idempotently and remain server-scoped", {
  skip: !pool ? "DATABASE_URL is not configured" : false
}, async (t) => {
  const app = Fastify();
  await registerRecoverySnapshotRoutes(app);
  const clusterId = randomUUID();
  const serverId = randomUUID();
  const otherServerId = randomUUID();
  const principalId = randomUUID();
  const token = "cg_srv_" + randomBytes(36).toString("base64url");
  const gridId = "test-grid-" + randomUUID();
  const snapshotId = "snapshot-" + randomUUID();
  const state = { slots: [{ itemId: "item-1", quantity: 2 }], metadata: { revision: 1 } };
  const capturedAt = new Date().toISOString();

  try {
    await pool.query("INSERT INTO core.clusters (id, game_key, name, status) VALUES ($1, 'atlas', 'Recovery test cluster', 'active')", [clusterId]);
    for (const id of [serverId, otherServerId]) {
      await pool.query("INSERT INTO core.servers (id, cluster_id, game_key, name, environment, status) VALUES ($1, $2, 'atlas', 'Recovery test server', 'test', 'offline')", [id, clusterId]);
    }
    await pool.query(
      "INSERT INTO games_atlas.maps (cluster_id, server_id, map_key, display_name) VALUES ($1, $2, $3, 'Recovery test grid')",
      [clusterId, serverId, gridId]
    );
    await pool.query(
      "INSERT INTO games_atlas.maps (cluster_id, server_id, map_key, display_name) VALUES ($1, $2, $3, 'Other recovery test grid')",
      [clusterId, otherServerId, "other-" + gridId]
    );
    await pool.query("INSERT INTO core.principals (id, principal_type, status) VALUES ($1, 'service', 'active')", [principalId]);
    await pool.query("INSERT INTO core.service_accounts (principal_id, application_name) VALUES ($1, $2)", [principalId, "snapshot-test-" + principalId]);
    await pool.query("INSERT INTO core.service_credentials (principal_id, credential_hash, label) VALUES ($1, $2, 'test')", [principalId, hashServiceToken(token)]);
    await pool.query(
      "INSERT INTO core.principal_role_assignments (principal_id, role_id, scope_type, scope_id) SELECT $1, id, 'server', $2 FROM core.roles WHERE role_key IN ('recovery_snapshot_writer', 'recovery_snapshot_reader')",
      [principalId, serverId]
    );

    const payload = {
      snapshotId, kind: "inventory", assetId: "character-42", ownerId: "steam-42",
      scope: { clusterId, gridId, serverId }, capturedAt, state, reason: "scheduled"
    };
    const post = () => app.inject({
      method: "POST",
      url: `/integrations/servers/${serverId}/recovery/snapshots`,
      headers: { authorization: "Bearer " + token },
      payload
    });

    const created = await post();
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().data.durable, true);
    assert.equal(created.json().data.duplicate, false);
    const receipt = created.json().data.receipt;

    const duplicate = await post();
    assert.equal(duplicate.statusCode, 200);
    assert.equal(duplicate.json().data.duplicate, true);
    assert.equal(duplicate.json().data.receipt, receipt);

    const conflict = await app.inject({
      method: "POST",
      url: `/integrations/servers/${serverId}/recovery/snapshots`,
      headers: { authorization: "Bearer " + token },
      payload: { ...payload, state: { changed: true } }
    });
    assert.equal(conflict.statusCode, 409);

    const read = await app.inject({
      method: "GET",
      url: `/integrations/servers/${serverId}/recovery/snapshots/${encodeURIComponent(snapshotId)}`,
      headers: { authorization: "Bearer " + token }
    });
    assert.equal(read.statusCode, 200);
    assert.deepEqual(read.json().data.state, state);

    const list = await app.inject({
      method: "GET",
      url: `/integrations/servers/${serverId}/recovery/snapshots?kind=inventory&assetId=character-42`,
      headers: { authorization: "Bearer " + token }
    });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().data.length, 1);
    assert.equal(list.json().data[0].snapshotId, snapshotId);

    const crossServer = await app.inject({
      method: "GET",
      url: `/integrations/servers/${otherServerId}/recovery/snapshots/${encodeURIComponent(snapshotId)}`,
      headers: { authorization: "Bearer " + token }
    });
    assert.equal(crossServer.statusCode, 403);
  } finally {
    await pool.query("DELETE FROM operations.atlas_recovery_snapshots WHERE server_id = ANY($1::uuid[])", [[serverId, otherServerId]]);
    await pool.query("DELETE FROM operations.audit_logs WHERE actor_principal_id = $1", [principalId]);
    await pool.query("DELETE FROM core.service_credentials WHERE principal_id = $1", [principalId]);
    await pool.query("DELETE FROM core.principal_role_assignments WHERE principal_id = $1", [principalId]);
    await pool.query("DELETE FROM core.service_accounts WHERE principal_id = $1", [principalId]);
    await pool.query("DELETE FROM core.principals WHERE id = $1", [principalId]);
    await pool.query("DELETE FROM games_atlas.maps WHERE server_id = ANY($1::uuid[])", [[serverId, otherServerId]]);
    await pool.query("DELETE FROM core.servers WHERE id = ANY($1::uuid[])", [[serverId, otherServerId]]);
    await pool.query("DELETE FROM core.clusters WHERE id = $1", [clusterId]);
    await app.close();
  }
});
