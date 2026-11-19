import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import Fastify from "fastify";
import { pool } from "../dist/db.js";
import { hashServiceToken } from "../dist/auth/service.js";
import { registerEventOutboxRoutes } from "../dist/routes/event-outbox.js";
import { registerAtlasQuestRoutes } from "../dist/routes/atlas-quests.js";

test("ATLAS quests publish immutable revisions and persist progress once per leased event", {
  skip: !pool ? "DATABASE_URL is not configured" : false
}, async () => {
  const app = Fastify();
  await registerEventOutboxRoutes(app);
  await registerAtlasQuestRoutes(app);
  await app.ready();
  const ids = { cluster: randomUUID(), server: randomUUID(), principal: randomUUID(), quest: randomUUID(), event: randomUUID(), eventRecord: randomUUID(), eventLeft: randomUUID(), eventLeftRecord: randomUUID(), eventLeftAgain: randomUUID(), eventLeftAgainRecord: randomUUID() };
  const token = "cg_srv_" + randomBytes(36).toString("base64url");
  const suffix = randomUUID();
  const platformId = "76561198000000000";
  const occurredAt = new Date().toISOString();
  const headers = { authorization: "Bearer " + token };
  const definition = {
    schemaVersion: 1, questId: ids.quest, revision: 1, name: "First Steps", enabled: true,
    scope: { clusterId: ids.cluster, gridIds: ["A1"] },
    objectives: [
      { id: "join-first-grid", eventType: "player.joined", targetCount: 3 },
      { id: "leave-first-grid", eventType: "player.left", targetCount: 3 }
    ]
  };

  try {
    await pool.query("INSERT INTO core.clusters (id, game_key, name, status) VALUES ($1, 'atlas', $2, 'active')", [ids.cluster, "Quest test " + suffix]);
    await pool.query("INSERT INTO core.servers (id, cluster_id, game_key, name, environment, status) VALUES ($1, $2, 'atlas', 'Quest test server', 'production', 'offline')", [ids.server, ids.cluster]);
    await pool.query("INSERT INTO games_atlas.maps (cluster_id, server_id, map_key, display_name) VALUES ($1, $2, 'A1', 'Quest test map')", [ids.cluster, ids.server]);
    await pool.query("INSERT INTO core.principals (id, principal_type, status) VALUES ($1, 'service', 'active')", [ids.principal]);
    await pool.query("INSERT INTO core.service_accounts (principal_id, application_name) VALUES ($1, $2)", [ids.principal, "atlas-quest-test-" + suffix]);
    await pool.query("INSERT INTO core.service_credentials (principal_id, credential_hash, label) VALUES ($1, $2, 'quest-test')", [ids.principal, hashServiceToken(token)]);
    await pool.query("INSERT INTO core.principal_role_assignments (principal_id, role_id, scope_type, scope_id) SELECT $1, id, 'cluster', $2 FROM core.roles WHERE role_key = 'atlas_quest_manager'", [ids.principal, ids.cluster]);
    await pool.query("INSERT INTO core.principal_role_assignments (principal_id, role_id, scope_type, scope_id) SELECT $1, id, 'server', $2 FROM core.roles WHERE role_key = 'atlas_quest_runtime'", [ids.principal, ids.server]);

    const publish = await app.inject({ method: "PUT", url: `/integrations/clusters/${ids.cluster}/quests/${ids.quest}`, headers, payload: { expectedRevision: 0, definition } });
    assert.equal(publish.statusCode, 201, publish.body);
    const conflict = await app.inject({ method: "PUT", url: `/integrations/clusters/${ids.cluster}/quests/${ids.quest}`, headers, payload: { expectedRevision: 0, definition } });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().error.code, "QUEST_REVISION_CONFLICT");

    const listed = await app.inject({ method: "GET", url: `/integrations/servers/${ids.server}/quests`, headers });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.equal(listed.json().data.length, 1);
    assert.equal(listed.json().data[0].revision, 1);

    await pool.query(
      `INSERT INTO operations.event_outbox (id, event_type, aggregate_type, aggregate_id, payload)
       VALUES ($1, 'game.event.received', 'game_event', $2, $3::jsonb)`,
      [ids.event, ids.eventRecord, JSON.stringify({ eventRecordId: ids.eventRecord, serverId: ids.server, clusterId: ids.cluster, gridId: "A1", correlationId: null, game: "atlas", eventId: "quest-test-" + suffix, eventType: "player.joined", occurredAt, payload: { platformId, playerName: "Quest Tester" } })]
    );
    await pool.query(
      `INSERT INTO operations.event_outbox (id, event_type, aggregate_type, aggregate_id, payload)
       VALUES ($1, 'game.event.received', 'game_event', $2, $3::jsonb)`,
      [ids.eventLeft, ids.eventLeftRecord, JSON.stringify({ eventRecordId: ids.eventLeftRecord, serverId: ids.server, clusterId: ids.cluster, gridId: "A1", correlationId: null, game: "atlas", eventId: "quest-left-test-" + suffix, eventType: "player.left", occurredAt, payload: { platformId, playerName: "Quest Tester" } })]
    );
    const claim = await app.inject({ method: "POST", url: `/integrations/servers/${ids.server}/events/claim`, headers, payload: { limit: 5, eventTypes: ["player.joined"] } });
    assert.equal(claim.statusCode, 200, claim.body);
    assert.equal(claim.json().data.length, 1);
    const leaseToken = claim.json().data[0].leaseToken;

    const progressUrl = `/integrations/servers/${ids.server}/quests/${ids.quest}/progress/${platformId}?revision=1`;
    const empty = await app.inject({ method: "GET", url: progressUrl, headers });
    assert.equal(empty.statusCode, 200, empty.body);
    assert.equal(empty.json().data.version, 0);
    const state = {
      schemaVersion: 1, questId: ids.quest, questRevision: 1, processedEventIds: [ids.event],
      players: { [platformId]: { objectives: { "join-first-grid": 1 }, completed: false, completedAt: null } }
    };
    const persistPayload = { revision: 1, eventId: ids.event, leaseToken, platformId, expectedVersion: 0, state };
    const initialJumpPayload = {
      ...persistPayload,
      state: { ...state, players: { [platformId]: { objectives: { "join-first-grid": 2 }, completed: false, completedAt: null } } }
    };
    const initialJump = await app.inject({ method: "POST", url: `/integrations/servers/${ids.server}/quests/${ids.quest}/progress`, headers, payload: initialJumpPayload });
    assert.equal(initialJump.statusCode, 400, initialJump.body);
    assert.equal(initialJump.json().error.code, "QUEST_PROGRESS_INVALID");

    const persisted = await app.inject({ method: "POST", url: `/integrations/servers/${ids.server}/quests/${ids.quest}/progress`, headers, payload: persistPayload });
    assert.equal(persisted.statusCode, 201, persisted.body);
    assert.equal(persisted.json().data.version, 1);
    const duplicate = await app.inject({ method: "POST", url: `/integrations/servers/${ids.server}/quests/${ids.quest}/progress`, headers, payload: persistPayload });
    assert.equal(duplicate.statusCode, 200, duplicate.body);
    assert.equal(duplicate.json().data.duplicate, true);

    const saved = await app.inject({ method: "GET", url: progressUrl, headers });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().data.version, 1);
    assert.deepEqual(saved.json().data.state.processedEventIds, []);
    assert.equal(saved.json().data.state.players[platformId].objectives["join-first-grid"], 1);

    const leftClaim = await app.inject({ method: "POST", url: `/integrations/servers/${ids.server}/events/claim`, headers, payload: { limit: 5, eventTypes: ["player.left"] } });
    assert.equal(leftClaim.statusCode, 200, leftClaim.body);
    const leftLeaseToken = leftClaim.json().data[0].leaseToken;
    const leftState = {
      schemaVersion: 1, questId: ids.quest, questRevision: 1, processedEventIds: [ids.eventLeft],
      players: { [platformId]: { objectives: { "join-first-grid": 1, "leave-first-grid": 1 }, completed: false, completedAt: null } }
    };
    const leftPersist = await app.inject({
      method: "POST",
      url: `/integrations/servers/${ids.server}/quests/${ids.quest}/progress`,
      headers,
      payload: { revision: 1, eventId: ids.eventLeft, leaseToken: leftLeaseToken, platformId, expectedVersion: 1, state: leftState }
    });
    assert.equal(leftPersist.statusCode, 201, leftPersist.body);
    assert.equal(leftPersist.json().data.version, 2);

    await pool.query(
      `INSERT INTO operations.event_outbox (id, event_type, aggregate_type, aggregate_id, payload)
       VALUES ($1, 'game.event.received', 'game_event', $2, $3::jsonb)`,
      [ids.eventLeftAgain, ids.eventLeftAgainRecord, JSON.stringify({ eventRecordId: ids.eventLeftAgainRecord, serverId: ids.server, clusterId: ids.cluster, gridId: "A1", correlationId: null, game: "atlas", eventId: "quest-left-again-test-" + suffix, eventType: "player.left", occurredAt, payload: { platformId, playerName: "Quest Tester" } })]
    );
    const secondLeftClaim = await app.inject({ method: "POST", url: `/integrations/servers/${ids.server}/events/claim`, headers, payload: { limit: 5, eventTypes: ["player.left"] } });
    assert.equal(secondLeftClaim.statusCode, 200, secondLeftClaim.body);
    assert.equal(secondLeftClaim.json().data.length, 1);
    const secondLeftLeaseToken = secondLeftClaim.json().data[0].leaseToken;
    const secondLeftState = {
      schemaVersion: 1, questId: ids.quest, questRevision: 1, processedEventIds: [ids.eventLeftAgain],
      players: { [platformId]: { objectives: { "join-first-grid": 1, "leave-first-grid": 2 }, completed: false, completedAt: null } }
    };
    const secondLeftUrl = `/integrations/servers/${ids.server}/quests/${ids.quest}/progress`;
    const existingProgressJump = await app.inject({
      method: "POST", url: secondLeftUrl, headers,
      payload: { revision: 1, eventId: ids.eventLeftAgain, leaseToken: secondLeftLeaseToken, platformId, expectedVersion: 2,
        state: { ...secondLeftState, players: { [platformId]: { objectives: { "join-first-grid": 1, "leave-first-grid": 3 }, completed: false, completedAt: null } } } }
    });
    assert.equal(existingProgressJump.statusCode, 400, existingProgressJump.body);
    assert.equal(existingProgressJump.json().error.code, "QUEST_PROGRESS_INVALID");

    const secondLeftPersist = await app.inject({
      method: "POST", url: secondLeftUrl, headers,
      payload: { revision: 1, eventId: ids.eventLeftAgain, leaseToken: secondLeftLeaseToken, platformId, expectedVersion: 2, state: secondLeftState }
    });
    assert.equal(secondLeftPersist.statusCode, 201, secondLeftPersist.body);
    assert.equal(secondLeftPersist.json().data.version, 3);

    const combined = await app.inject({ method: "GET", url: progressUrl, headers });
    assert.equal(combined.json().data.state.players[platformId].objectives["join-first-grid"], 1);
    assert.equal(combined.json().data.state.players[platformId].objectives["leave-first-grid"], 1);

    const ack = await app.inject({ method: "POST", url: `/integrations/servers/${ids.server}/events/${ids.event}/ack`, headers, payload: { leaseToken, outcome: "delivered" } });
    assert.equal(ack.statusCode, 202, ack.body);
  } finally {
    await pool.query("DELETE FROM games_atlas.quest_event_receipts WHERE cluster_id = $1", [ids.cluster]);
    await pool.query("DELETE FROM games_atlas.quest_progress WHERE cluster_id = $1", [ids.cluster]);
    await pool.query("DELETE FROM games_atlas.quests WHERE cluster_id = $1", [ids.cluster]);
    await pool.query("DELETE FROM operations.event_outbox WHERE id = ANY($1::uuid[])", [[ids.event, ids.eventLeft, ids.eventLeftAgain]]);
    await pool.query("DELETE FROM operations.audit_logs WHERE actor_principal_id = $1", [ids.principal]);
    await pool.query("DELETE FROM core.service_credentials WHERE principal_id = $1", [ids.principal]);
    await pool.query("DELETE FROM core.principal_role_assignments WHERE principal_id = $1", [ids.principal]);
    await pool.query("DELETE FROM core.service_accounts WHERE principal_id = $1", [ids.principal]);
    await pool.query("DELETE FROM core.principals WHERE id = $1", [ids.principal]);
    await pool.query("DELETE FROM games_atlas.maps WHERE server_id = $1", [ids.server]);
    await pool.query("DELETE FROM core.servers WHERE id = $1", [ids.server]);
    await pool.query("DELETE FROM core.clusters WHERE id = $1", [ids.cluster]);
    await app.close();
  }
});
