# Commerce API

## Public product catalogue

`GET /catalog/products?currency=USD`

Returns active products with a currently valid price for the requested ISO 4217 currency. This endpoint is public and does not require a player session.

## Checkout capability

`GET /commerce/checkout/status`

Returns whether checkout is enabled, the provider and the current mode. The implemented provider/mode is Stripe test mode only. A disabled response means the client must not show a working checkout action.

## Create an order

`POST /commerce/orders`

Requires a player bearer session and an `Idempotency-Key` header (8–128 characters).

```json
{
  "currency": "USD",
  "items": [
    { "productId": "00000000-0000-4000-8000-000000000000", "quantity": 1 }
  ]
}
```

Order creation snapshots the selected product name, SKU and price, writes a `commerce.order.created` outbox event, and creates a pending order. It does **not** debit a wallet or charge a payment method. Reusing an idempotency key with a different request body returns a conflict; reusing the same request returns the existing order.

## Create a Stripe test checkout session

`POST /commerce/orders/:orderId/checkout`

Requires the order owner's player bearer session and an `Idempotency-Key` header (8–128 characters). Core verifies order ownership and accepts orders in `pending` or `awaiting_payment` state. If an unexpired Stripe transaction with an active checkout URL already exists, Core returns that session. If the prior session failed or expired, Core creates a replacement session using a derived provider idempotency key. The order remains `awaiting_payment` until a verified webhook changes its state. The response includes `checkoutUrl`, `sessionId` and `expiresAt`.

The Stripe secret and webhook signing secret stay in the Core API environment. Live-mode keys are rejected by the current checkout capability gate. The browser redirect is not proof of payment.

## Stripe test webhook

`POST /webhooks/stripe`

Core verifies the timestamp and HMAC signature against the exact raw request body, checks the order amount and currency, and processes supported test-mode checkout events idempotently. A verified successful payment marks the order paid, creates entitlements and writes a `commerce.order.paid` outbox event.

The current supported test-mode event set is documented in [Stripe test-mode checkout](../commerce/stripe-test-mode.md). Production payment keys, live-mode checkout and refund automation are not enabled.

## Player entitlements

`GET /account/entitlements`

Requires a player bearer session. Returns the authenticated player's entitlements and configured game delivery targets. Entitlements, payment transactions and game delivery attempts are separate records.

## Claim an entitlement for game delivery

`POST /account/entitlements/:entitlementId/claim`

Requires a player bearer session and an active, non-expired entitlement. The player must have a verified, linked Steam account and the product must have at least one valid game/server delivery mapping.

Core inserts or reuses durable reward-queue records with deterministic idempotency keys and returns HTTP 202 with the queue records. This endpoint **queues** delivery; it does not grant an item in ATLAS and must not be reported as delivered.

## Player order history

`GET /account/orders`

Requires a player bearer session. Returns the authenticated player's recent orders and their latest payment status.

## Server reward worker contract

These endpoints are for an authenticated, server-scoped service credential—not a browser or player token.

- `POST /integrations/servers/:serverId/rewards/claim` requires `rewards.claim`. The optional `limit` is 1–100. Core leases eligible jobs for 120 seconds and returns the delivery payload, stable idempotency key and lease expiry.
- `POST /integrations/servers/:serverId/rewards/:rewardId/ack` requires `rewards.ack`. The worker reports `delivered` or `failed`; Core records the attempt and audit entry, and failed jobs receive a bounded retry delay.

**Lease fencing:** Core requires the per-claim lease token when acknowledging a reward, so a stale worker cannot acknowledge a newer claim. The game adapter must still enforce grant-side idempotency with the stable reward ID or idempotency key; lease fencing alone cannot guarantee exactly-once game grants.

The claim response includes a stable `idempotencyKey`. The worker/game adapter must persist and enforce grant-side deduplication with that key (or the immutable reward ID) across retries, disconnects and restarts. It must acknowledge `delivered` only after confirming the grant. The routes and lease schema exist, but they are not themselves a running worker. The native ATLAS grant adapter still requires isolated runtime validation.

## Wallets and wallet-funded orders

- `GET /account/wallets` returns the authenticated player's wallet balances. Balances are derived from the append-only ledger; amounts are returned as decimal strings to preserve integer precision.
- `GET /account/wallets/{currencyCode}/ledger?limit=50` returns the most recent ledger entries for one of that player's wallets (maximum 100 entries per request).
- `POST /commerce/orders/{orderId}/pay-with-wallet` atomically debits the matching wallet, records a `wallet` payment transaction, marks the order paid, and invokes the same entitlement/reward fulfillment path used by verified Stripe payments. The order ID is the idempotency boundary; repeated requests do not debit twice.
- `PUT /admin/commerce/products/{productId}/wallet-mapping` configures the wallet currency and credit amount granted by a `currency_pack` product. The mapping is copied onto each order item when the order is created so later catalog changes cannot alter a paid top-up.

Currency-pack products must have a wallet mapping before they can appear in the public catalog or be ordered. Use a dedicated non-fiat wallet code (for example, `ATK`); a code registered as a wallet currency is treated as wallet-only and cannot be sent to Stripe checkout. Currency packs must be purchased through the configured external payment provider and cannot be purchased with the wallet they replenish. A verified Stripe success credits the mapped wallet through an idempotent ledger entry and does not create a game entitlement or reward delivery.

Wallet-funded orders require a configured wallet currency, sufficient balance, and no active or successful external payment attempt. The debit, payment transaction, paid order transition, entitlement creation, reward queue insertion, event-outbox entry, and audit record commit in one database transaction.

## Not implemented

- Manual wallet adjustments and player-to-player transfers.
- Production/live payment mode and refund automation.
- A running reward-delivery worker and verified native ATLAS item/creature grant implementation.

Do not accept payment details or claim that an in-game reward was delivered until Core has verified payment and the server-side worker has confirmed the game grant.
