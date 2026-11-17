# ATLAS Quest Persistence API

Core is the durable storage boundary for Adventures. Adventures owns quest rules and progress calculation; Core validates scope, stores versioned definitions, serializes progress updates, and records outbox-event receipts. Plugins never connect directly to PostgreSQL.

## Publish a quest revision

`PUT /integrations/clusters/{clusterId}/quests/{questId}`

Requires a cluster-scoped `atlas_quest_manager` service identity and the next revision number.

```json
{
  "expectedRevision": 0,
  "definition": {
    "schemaVersion": 1,
    "questId": "00000000-0000-4000-8000-000000000000",
    "revision": 1,
    "name": "First Steps",
    "enabled": true,
    "scope": { "clusterId": "00000000-0000-4000-8000-000000000001", "gridIds": ["A1"] },
    "objectives": [{ "id": "join-first-grid", "eventType": "player.joined", "targetCount": 1 }]
  }
}
```

Revisions are immutable. The caller supplies `expectedRevision`; Core returns `409 QUEST_REVISION_CONFLICT` if another writer published first. To disable or change a quest, publish a new revision.

## Read enabled quests

`GET /integrations/servers/{serverId}/quests`

Requires `quests.read` on the exact server. Core returns the latest enabled revision whose cluster/grid/server scope includes that server.

## Read player progress

`GET /integrations/servers/{serverId}/quests/{questId}/progress/{platformId}?revision=1`

Requires `quests.progress.read` on the exact server. A player with no progress returns `state: null` and `version: 0`.

## Persist progress for a claimed event

`POST /integrations/servers/{serverId}/quests/{questId}/progress`

Requires `quests.progress.write` on the exact server and an active Core `game.event.received` lease held by the same service identity. The request includes the outbox event ID and lease token, expected progress version, and the new state produced by Adventures. Core verifies the event/server/grid/player identity, quest scope and revision, objective bounds, monotonic progress, and completion consistency.

The event receipt and progress update commit in one transaction. A duplicate event is acknowledged without applying progress again. Concurrent updates return `409 QUEST_PROGRESS_CONFLICT`; the worker reloads state and reapplies the event. Core clears the in-state processed-event list after persistence because durable receipts are stored separately.

## Service identities

- Runtime worker: `npm run service:create -- atlas-adventures --role atlas_quest_runtime --scope-type server --scope-id <SERVER_UUID>`
- Quest publisher: `npm run service:create -- atlas-quest-manager --role atlas_quest_manager --scope-type cluster --scope-id <CLUSTER_UUID>`

The runtime role includes only event claim/ack and quest read/progress permissions. The manager role can publish definitions only for its assigned cluster.
