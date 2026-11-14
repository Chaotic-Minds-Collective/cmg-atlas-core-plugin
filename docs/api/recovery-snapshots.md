# ATLAS Recovery Snapshot API

This API stores bounded pre-loss snapshots for the Player recovery workflow. It is a Core-owned persistence boundary; plugins must not connect directly to the Core database.

## Authorization

Both permissions are server-scoped:

- `recovery.snapshots.write` — persist snapshots
- `recovery.snapshots.read` — list and retrieve snapshots

Create dedicated service identities rather than reusing a broad platform credential:

```sh
npm run service:create -- atlas-player-snapshot-writer --role recovery_snapshot_writer --scope-type server --scope-id <SERVER_UUID>
npm run service:create -- atlas-player-snapshot-reader --role recovery_snapshot_reader --scope-type server --scope-id <SERVER_UUID>
```

## Persist a snapshot

`POST /integrations/servers/{serverId}/recovery/snapshots`

The request must include a `scope` whose server ID matches the path. Core verifies that the server belongs to the supplied cluster and that the supplied grid ID matches the registered ATLAS map key for that server.

```json
{
  "snapshotId": "provider-generated-stable-id",
  "kind": "inventory",
  "assetId": "provider-character-id",
  "ownerId": "provider-owner-id",
  "scope": {
    "clusterId": "00000000-0000-4000-8000-000000000001",
    "gridId": "provider-map-key",
    "serverId": "00000000-0000-4000-8000-000000000002"
  },
  "capturedAt": "2026-11-14T20:00:00.000Z",
  "state": {
    "items": []
  },
  "reason": "scheduled"
}
```

State is limited to 16 MiB of UTF-8 JSON. A successful response includes `durable: true` and a Core receipt ID. Repeating the same snapshot ID and identical content is idempotent; reusing it with different content returns `409 SNAPSHOT_ID_CONFLICT`.

## Retrieve snapshots

- `GET /integrations/servers/{serverId}/recovery/snapshots?kind=inventory&assetId={assetId}&limit=25`
- `GET /integrations/servers/{serverId}/recovery/snapshots/{snapshotId}`

List results contain metadata only. The single-snapshot endpoint returns the stored state. Results are always constrained to the server in the path and require the exact server-scoped read permission.

## Storage and operational limits

- The database stores JSONB state and metadata; it does not encrypt the payload at the application layer. Protect the database using the hosting provider's encryption-at-rest controls, network restrictions, backups, and credential isolation before using real player data.
- No automatic capture schedule, retention deletion, restore execution, or game-server callback is implemented here.
- Retention duration and storage budget must be chosen before production use. Do not enable unbounded snapshot capture.
- The API validates registered server/cluster/grid topology but cannot prove that the plugin's source adapter captured authentic game state.
- This API is not a substitute for testing the installed ATLAS server build, loader, SDK, and native callbacks on an isolated server.
