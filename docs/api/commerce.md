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

Requires the order owner's player bearer session and an `Idempotency-Key` header (8–128 characters). Core verifies order ownership and pending status, then creates or reuses a Stripe Checkout session in **test mode**. The response includes `checkoutUrl`, `sessionId` and `expiresAt`.

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
- `POST /integrations/servers/:serverId/rewards/:rewardId/ack` requires `rewards.ack`. The worker reports `delivered` or `failed` while holding the active lease. Core records the attempt and audit entry; failed jobs receive a bounded retry delay.

The routes and lease schema exist, but they are not themselves a running worker. The worker must perform the game-side grant and acknowledge `delivered` only after confirming the result. The native ATLAS grant adapter still requires isolated runtime validation.

## Wallet API status

The Core commerce schema contains wallet and ledger tables, but Core does not yet expose a public wallet-balance, wallet-ledger, spend or transfer endpoint. Do not query those tables directly from Commerce or a game plugin. Virtual-currency purchases require a future atomic Core transaction that combines the ledger debit, order state and entitlement creation.

## Not implemented

- Public wallet balance/ledger, wallet spending, credits/adjustments and player transfers.
- Production/live payment mode and refund automation.
- A running reward-delivery worker and verified native ATLAS item/creature grant implementation.

Do not accept payment details or claim that an in-game reward was delivered until Core has verified payment and the server-side worker has confirmed the game grant.
