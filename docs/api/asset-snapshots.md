# Encrypted Asset Snapshot API

Core stores recovery snapshots as opaque encrypted envelopes. It never receives or stores plaintext inventory, tame, or ship state and does not manage encryption keys.

## Envelope requirements

- Algorithm: AES-256-GCM
- Nonce: 12 bytes, canonical base64
- Authentication tag: 16 bytes, canonical base64
- Ciphertext: canonical base64, at most 1 MiB of plaintext-equivalent payload (1,398,104 encoded bytes)
- Key ID: non-secret identifier used by the external key provider
- State size: 1–1,048,576 bytes

The producer must encrypt serialized snapshot state before sending it to Core. Encryption keys must remain outside Core and outside the database. The producer must use a unique nonce for each encryption under a given key. The API does not supply key material, decrypt snapshots, or claim that a key provider is configured.

## Store

POST /integrations/servers/{serverId}/snapshots

Requires a service credential with asset_snapshot_manager assigned to the exact server scope.

Request:

```json
{
  "snapshotId": "00000000-0000-4000-8000-000000000001",
  "clusterId": "00000000-0000-4000-8000-000000000002",
  "gridId": "A1",
  "kind": "ship",
  "assetId": "provider-ship-id",
  "ownerId": "provider-owner-id",
  "capturedAt": "2026-11-14T12:00:00.000Z",
  "reason": "pre-loss",
  "schemaVersion": 1,
  "stateBytes": 4096,
  "encryption": {
    "algorithm": "AES-256-GCM",
    "keyId": "atlas-snapshot-key-v1",
    "nonce": "AAAAAAAAAAAAAAAA",
    "authTag": "AAAAAAAAAAAAAAAAAAAAAA==",
    "ciphertext": "BASE64_CIPHERTEXT"
  }
}
```

A new snapshot returns 201 with durable: true and a persistence receipt. Replaying the same snapshot ID and identical content is idempotent and returns 200. Reusing an ID with different content or scope returns 409 SNAPSHOT_ID_CONFLICT. The server must be an active ATLAS server and the submitted cluster must match its registered cluster.

## List snapshots for a lost asset

GET /integrations/servers/{serverId}/snapshots?kind=ship&assetId=provider-ship-id&before=<ISO-8601>&limit=25

kind and assetId are required. before is optional and exclusive; it selects snapshots captured before a loss event. limit defaults to 25 and is bounded from 1 to 100. The list contains metadata only, not ciphertext.

## Retrieve one encrypted snapshot

GET /integrations/servers/{serverId}/snapshots/{snapshotId}

Returns the encrypted envelope and metadata only for the requested server. Decryption and validation remain the responsibility of a separately authorized consumer.

## Service account

```sh
npm run service:create -- atlas-snapshot-store --role asset_snapshot_manager --scope-type server --scope-id <SERVER_UUID>
```

The role grants only snapshots.write and snapshots.read. Each environment and server should use a distinct service identity.

## Boundaries and operational gates

- All snapshot payload bytes are encrypted before transmission; Core stores opaque ciphertext only.
- Core stores no encryption keys and does not decrypt, restore, or mutate game state.
- Reads and writes are restricted to the exact assigned server and audited without logging ciphertext.
- No automatic retention or deletion is enabled in this phase. A retention period, storage budget, key rotation/recovery procedure, and external key provider must be selected before production use.
- A real ATLAS adapter must still prove authoritative inventory, tame, and ship capture sources on the exact installed server build.
- No live server integration, scheduler, game callback, or restore operation is included.
