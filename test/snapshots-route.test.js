import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import Fastify from "fastify";
import { pool } from "../dist/db.js";
import { hashServiceToken } from "../dist/auth/service.js";
import { registerSnapshotRoutes } from "../dist/routes/snapshots.js";

test("encrypted asset snapshots are server-scoped, durable, idempotent, and retrievable", {
  skip: !pool ? "DATABASE_URL is not configured" : false
}, async () => {
  const app = Fastify();
  await registerSnapshotRoutes(app);
  const clusterId = randomUUID();
  const serverId = randomUUID();
  const otherServerId = randomUUID();
  const principalId = randomUUID();
  const readerPrincipalId = randomUUID();
  const token = "cg_srv_" + randomBytes(36).toString("base64url");
  const readerToken = "cg_srv_" + randomBytes(36).toString("base64url");
  const snapshotId = randomUUID();
  const applicationName = "snapshot-test-" + principalId;
  const readerApplicationName = "snapshot-reader-test-" + readerPrincipalId;
  const nonce = randomBytes(12).toString("base64");
  const authTag = randomBytes(16).toString("base64");
  const ciphertext = randomBytes(128).toString("base64");
  const capturedAt = new Date(Date.now() - 60_000).toISOString();
  const payload = {
    snapshotId, clusterId, gridId: "A1", kind: "ship", assetId: "ship-42",
    ownerId: "provider-owner-7", capturedAt, reason: "pre-loss", schemaVersion: 1,
    stateBytes: 128,
    encryption: { algorithm: "AES-256-GCM", keyId: "test-key-v1", nonce, authTag, ciphertext }
  };

  try {
    await pool.query("INSERT INTO core.clusters (id, game_key, name, status) VALUES ($1, 'atlas', $2, 'active')", [clusterId, "Snapshot test " + clusterId]);
    for (const id of [serverId, otherServerId]) {
      await pool.query("INSERT INTO core.servers (id, cluster_id, game_key, name, environment, status) VALUES ($1, $2, 'atlas', 'Snapshot test server', 'test', 'offline')", [id, clusterId]);
    }
    await pool.query("INSERT INTO core.principals (id, principal_type, status) VALUES ($1, 'service', 'active')", [principalId]);
    await pool.query("INSERT INTO core.service_accounts (principal_id, application_name) VALUES ($1, $2)", [principalId, applicationName]);
    await pool.query("INSERT INTO core.service_credentials (principal_id, credential_hash, label) VALUES ($1, $2, 'test')", [principalId, hashServiceToken(token)]);
    await pool.query("INSERT INTO core.principal_role_assignments (principal_id, role_id, scope_type, scope_id) SELECT $1, id, 'server', $2 FROM core.roles WHERE role_key = 'asset_snapshot_manager'", [principalId, serverId]);
    await pool.query("INSERT INTO core.principals (id, principal_type, status) VALUES ($1, 'service', 'active')", [readerPrincipalId]);
    await pool.query("INSERT INTO core.service_accounts (principal_id, application_name) VALUES ($1, $2)", [readerPrincipalId, readerApplicationName]);
    await pool.query("INSERT INTO core.service_credentials (principal_id, credential_hash, label) VALUES ($1, $2, 'read-only test')", [readerPrincipalId, hashServiceToken(readerToken)]);
    await pool.query("INSERT INTO core.principal_role_assignments (principal_id, role_id, scope_type, scope_id) SELECT $1, id, 'server', $2 FROM core.roles WHERE role_key = 'asset_snapshot_reader'", [readerPrincipalId, serverId]);

    const headers = { authorization: "Bearer " + token };
    const readerHeaders = { authorization: "Bearer " + readerToken };
    const url = "/integrations/servers/" + serverId + "/snapshots";
    const uppercaseUrl = "/integrations/servers/" + serverId.toUpperCase() + "/snapshots";
    const uppercasePayload = { ...payload, snapshotId: snapshotId.toUpperCase(), clusterId: clusterId.toUpperCase() };
    const stored = await app.inject({ method: "POST", url: uppercaseUrl, headers, payload: uppercasePayload });
    assert.equal(stored.statusCode, 201, stored.body);
    assert.equal(stored.json().data.durable, true);
    assert.equal(stored.json().data.snapshotId, snapshotId);

    const otherOwnerPayload = {
      ...payload,
      snapshotId: randomUUID(),
      ownerId: "provider-owner-8",
      encryption: {
        ...payload.encryption,
        keyId: "test-key-v2",
        nonce: randomBytes(12).toString("base64"),
        authTag: randomBytes(16).toString("base64"),
        ciphertext: randomBytes(128).toString("base64")
      }
    };
    const otherOwnerStored = await app.inject({ method: "POST", url, headers, payload: otherOwnerPayload });
    assert.equal(otherOwnerStored.statusCode, 201, otherOwnerStored.body);

    const duplicate = await app.inject({ method: "POST", url, headers, payload });
    assert.equal(duplicate.statusCode, 200, duplicate.body);
    assert.equal(duplicate.json().data.duplicate, true);

    const uppercaseReplay = await app.inject({ method: "POST", url: uppercaseUrl, headers, payload: uppercasePayload });
    assert.equal(uppercaseReplay.statusCode, 200, uppercaseReplay.body);
    assert.equal(uppercaseReplay.json().data.duplicate, true);

    for (const field of ["gridId", "assetId", "ownerId", "keyId"]) {
      const invalid = field === "keyId"
        ? { ...payload, encryption: { ...payload.encryption, keyId: "   " } }
        : { ...payload, [field]: "   " };
      const response = await app.inject({ method: "POST", url, headers, payload: invalid });
      assert.equal(response.statusCode, 400, field + ": " + response.body);
      assert.equal(response.json().error.code, "VALIDATION_ERROR");
    }
    const oversized = await app.inject({ method: "POST", url, headers, payload: {
      ...payload, stateBytes: 1_048_576,
      encryption: { ...payload.encryption, ciphertext: Buffer.alloc(1_048_577).toString("base64") }
    } });
    assert.equal(oversized.statusCode, 400, oversized.body);

    for (const before of ["0", "not-a-date", "2026-02-30T12:00:00Z", "0000-01-01T00:00:00Z", "2026-01-01T12:00:00+23:00"]) {
      const invalidBefore = await app.inject({ method: "GET", headers,
        url: url + "?kind=ship&assetId=ship-42&before=" + encodeURIComponent(before) });
      assert.equal(invalidBefore.statusCode, 400, before + ": " + invalidBefore.body);
      assert.equal(invalidBefore.json().error.code, "VALIDATION_ERROR");
    }

    const list = await app.inject({
      method: "GET",
      url: uppercaseUrl + "?kind=ship&assetId=ship-42&ownerId=provider-owner-7&before=" + encodeURIComponent(new Date().toISOString()),
      headers
    });
    assert.equal(list.statusCode, 200, list.body);
    assert.equal(list.json().data.length, 1);
    assert.equal(list.json().data[0].snapshotId, snapshotId);
    assert.equal(Object.hasOwn(list.json().data[0], "ciphertext"), false);

    const audit = await pool.query("SELECT metadata FROM operations.audit_logs WHERE actor_principal_id = $1 AND action = 'asset_snapshot.read'", [principalId]);
    assert.equal(audit.rows.length, 1);
    assert.deepEqual(audit.rows[0].metadata, { serverId, kind: "ship", assetId: "ship-42", ownerId: "provider-owner-7", resultCount: 1 });

    const allOwners = await app.inject({ method: "GET", url: url + "?kind=ship&assetId=ship-42", headers });
    assert.equal(allOwners.statusCode, 200, allOwners.body);
    assert.equal(allOwners.json().data.length, 2);

    for (const before of [capturedAt, capturedAt.replace(/Z$/, "000+00:00")]) {
      const exclusive = await app.inject({ method: "GET", headers,
        url: url + "?kind=ship&assetId=ship-42&before=" + encodeURIComponent(before) });
      assert.equal(exclusive.statusCode, 200, exclusive.body);
      assert.deepEqual(exclusive.json().data, []);
    }
    const preciseBefore = capturedAt.replace(/(\.\d{3})Z$/, "$1001+00:00");
    const precise = await app.inject({ method: "GET", headers,
      url: url + "?kind=ship&assetId=ship-42&before=" + encodeURIComponent(preciseBefore) });
    assert.equal(precise.statusCode, 200, precise.body);
    assert.equal(precise.json().data.length, 2, "preserve microsecond precision in before");

    const falseSize = await app.inject({ method: "POST", url, headers, payload: { ...payload, snapshotId: randomUUID(), stateBytes: 512 } });
    assert.equal(falseSize.statusCode, 400, falseSize.body);

    const nonceReuse = await app.inject({ method: "POST", url, headers, payload: { ...payload, snapshotId: randomUUID() } });
    assert.equal(nonceReuse.statusCode, 409, nonceReuse.body);
    assert.equal(nonceReuse.json().error.code, "SNAPSHOT_NONCE_CONFLICT");

    const changedContent = await app.inject({ method: "POST", url, headers, payload: { ...payload, ownerId: "changed" } });
    assert.equal(changedContent.statusCode, 409, changedContent.body);
    assert.equal(changedContent.json().error.code, "SNAPSHOT_ID_CONFLICT");

    const fetched = await app.inject({ method: "GET", url: uppercaseUrl + "/" + snapshotId.toUpperCase(), headers });
    assert.equal(fetched.statusCode, 200, fetched.body);
    assert.equal(fetched.json().data.serverId, serverId);
    assert.equal(fetched.json().data.ciphertext, ciphertext);
    assert.equal(fetched.json().data.nonce, nonce);
    assert.equal(fetched.json().data.authTag, authTag);

    const readerList = await app.inject({ method: "GET", url: url + "?kind=ship&assetId=ship-42", headers: readerHeaders });
    assert.equal(readerList.statusCode, 200, readerList.body);
    const readerDetail = await app.inject({ method: "GET", url: url + "/" + snapshotId, headers: readerHeaders });
    assert.equal(readerDetail.statusCode, 200, readerDetail.body);
    const readerWrite = await app.inject({
      method: "POST", url, headers: readerHeaders,
      payload: { ...payload, snapshotId: randomUUID(), encryption: { ...payload.encryption, keyId: "reader-write-test", nonce: randomBytes(12).toString("base64") } }
    });
    assert.equal(readerWrite.statusCode, 403, readerWrite.body);

    const wrongScope = await app.inject({ method: "POST", url: "/integrations/servers/" + otherServerId + "/snapshots", headers, payload });
    assert.equal(wrongScope.statusCode, 403);

    const mismatchedCluster = await app.inject({ method: "POST", url, headers, payload: { ...payload, snapshotId: randomUUID(), clusterId: randomUUID() } });
    assert.equal(mismatchedCluster.statusCode, 409);

    const invalidEnvelope = await app.inject({
      method: "POST", url, headers,
      payload: { ...payload, snapshotId: randomUUID(), encryption: { ...payload.encryption, algorithm: "none" } }
    });
    assert.equal(invalidEnvelope.statusCode, 400);

    await pool.query("UPDATE core.servers SET status = 'deleted' WHERE id = $1", [serverId]);
    const deletedList = await app.inject({ method: "GET", url: url + "?kind=ship&assetId=ship-42", headers });
    assert.equal(deletedList.statusCode, 200, deletedList.body);
    assert.deepEqual(deletedList.json().data, []);
    const deletedDetail = await app.inject({ method: "GET", url: url + "/" + snapshotId, headers });
    assert.equal(deletedDetail.statusCode, 404, deletedDetail.body);
    const deletedWrite = await app.inject({ method: "POST", url, headers, payload });
    assert.equal(deletedWrite.statusCode, 404, deletedWrite.body);
  } finally {
    await pool.query("DELETE FROM operations.asset_snapshots WHERE server_id = ANY($1::uuid[])", [[serverId, otherServerId]]);
    await pool.query("DELETE FROM operations.audit_logs WHERE actor_principal_id = ANY($1::uuid[])", [[principalId, readerPrincipalId]]);
    await pool.query("DELETE FROM core.service_credentials WHERE principal_id = ANY($1::uuid[])", [[principalId, readerPrincipalId]]);
    await pool.query("DELETE FROM core.principal_role_assignments WHERE principal_id = ANY($1::uuid[])", [[principalId, readerPrincipalId]]);
    await pool.query("DELETE FROM core.service_accounts WHERE principal_id = ANY($1::uuid[])", [[principalId, readerPrincipalId]]);
    await pool.query("DELETE FROM core.principals WHERE id = ANY($1::uuid[])", [[principalId, readerPrincipalId]]);
    await pool.query("DELETE FROM core.servers WHERE id = ANY($1::uuid[])", [[serverId, otherServerId]]);
    await pool.query("DELETE FROM core.clusters WHERE id = $1", [clusterId]);
    await app.close();
  }
});
