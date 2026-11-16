# ATLAS Insurance Claims API

This Core slice implements evidence-backed insurance claim submission and platform-admin review. It does not restore a tame or ship in the game.

## Product configuration

Create the store product through the existing commerce product administration flow, using the existing `game_entitlement` product type. Configure the insurance product with one row in `commerce.atlas_insurance_products`:

- `product_id`: the commerce product UUID
- `asset_kind`: `tame` or `ship`
- `coverage_seconds`: coverage duration from the entitlement grant time

Entitlements continue to be granted only by the existing verified payment flow. This feature does not create a parallel store or payment path.

## Submit a claim

`POST /account/atlas/insurance/claims`

Requires a player bearer session and an `Idempotency-Key` header (8–128 characters).

```json
{
  "assetKind": "tame",
  "assetId": "server-asset-id",
  "lossEventId": "adapter-event-id",
  "scope": {
    "serverId": "00000000-0000-4000-8000-000000000001",
    "clusterId": "00000000-0000-4000-8000-000000000002",
    "gridId": "NA-PVE-01"
  }
}
```

Core requires:
- A verified, currently active Steam link for the player.
- A registered ATLAS server, cluster, and grid that match exactly.
- A server-ingested `tame.died` or `ship.sunk` event matching the asset ID and verified Steam owner.
- An active insurance entitlement for the matching asset kind, covering the loss timestamp.
- An eligible pre-loss recovery snapshot for the same asset, owner, server, cluster, and grid.
- An unused claim allowance on that entitlement.

Repeated requests with the same principal, idempotency key, and body return the original claim. Reusing the key with a different body returns a conflict. A loss event can be claimed only once.

## Admin review

- `GET /admin/atlas/insurance/claims?status=submitted&limit=50`
- `POST /admin/atlas/insurance/claims/:claimId/decision`

Both endpoints require the `atlas.insurance.claims.review` permission assigned at platform scope. The migration grants this permission to the existing `platform_admin` role only. Player-facing UI restrictions are not used as authorization.

Decision body:

```json
{ "decision": "approve", "note": "Evidence reviewed" }
```

An approval emits `atlas.insurance.recovery.authorized` to the existing Core event outbox. The event is an authorization contract for a future verified adapter; it is not proof that a restoration happened.

## Explicit implementation boundary

- Core validates coverage, ownership evidence, loss event, scope, snapshot, and admin review.
- Core does not perform native tame/ship restoration.
- The adapter must later verify its live target and consume the authorization on the exact server/grid.
- No native restore API or callback is assumed.
- No production migration, product activation, payment configuration, deployment, or live-server change is performed by this PR.
