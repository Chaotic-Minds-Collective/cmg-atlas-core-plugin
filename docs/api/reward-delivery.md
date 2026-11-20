# Game Reward Delivery API

A reward is created only after the Core has granted a valid entitlement. A pending order or browser redirect does not create a deliverable reward.

## Claim

`POST /integrations/servers/{serverId}/rewards/claim`

Requires a `reward_worker` service identity scoped to the exact server.

Request:

```json
{ "limit": 10 }
```

The Core claims up to 100 available rewards in a transaction, increments attempts, and grants a lease to the service identity. The request may set `leaseSeconds` from 15 to 300 (default 120). Expired processing leases can be reclaimed.

## Renew

`POST /integrations/servers/{serverId}/rewards/{rewardId}/renew`

Requires the same `reward_worker` service identity scoped to the exact server and the current lease token.

Request:

```json
{ "leaseToken": "current-claim-token", "leaseSeconds": 120 }
```

Only the service holding the current, unexpired lease can renew it. Renewal extends the expiry to at least the requested duration from the current database time; it never changes the lease token. A stale, expired, or differently scoped claim is rejected with `409 REWARD_LEASE_INVALID`.

The worker should renew before the lease approaches expiry and stop dispatching if renewal cannot be confirmed.

## Acknowledge

`POST /integrations/servers/{serverId}/rewards/{rewardId}/ack`

Success:

```json
{ "outcome": "delivered", "response": { "providerReceipt": "game-specific-reference" } }
```

Failure:

```json
{ "outcome": "failed", "error": "The game server rejected the grant." }
```

Failed attempts are retained and retried with exponential backoff capped at one hour. If the adapter cannot determine whether a game grant succeeded (for example, after a crash between inventory mutation and receipt persistence), it must acknowledge `manual_review`; Core parks the reward and does not automatically retry it.

Only a platform commerce administrator can reconcile a parked reward through `POST /admin/commerce/rewards/{rewardId}/reconcile` with `resolution: "delivered"` after verifying the grant, or `resolution: "retry"` after verifying no grant occurred. A reconciliation note is mandatory and audited.

Acknowledgements must come from the service identity holding the active lease. Duplicate successful acknowledgements are idempotent.

## Service account

`npm run service:create -- 7dtd-reward-worker --role reward_worker --scope-type server --scope-id <SERVER_UUID>`

## Delivery boundary

These endpoints manage durable queue state. They do not themselves grant items inside a game. The adapter must validate the target identity, invoke a game-version-specific delivery method, and acknowledge success only after the game confirms the grant. Refund/revocation reconciliation is a separate workflow.


## Manual reconciliation

`POST /admin/commerce/rewards/{rewardId}/reconcile`

Requires platform-scoped `commerce.manage`.

```json
{ "resolution": "retry", "note": "Verified no item was granted." }
```

Allowed resolutions are `delivered` or `retry`. The reward must currently be in `manual_review`. This endpoint records an audit entry and either marks the reward delivered or returns it to the retry queue.
