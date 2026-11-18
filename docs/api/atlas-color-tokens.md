# ATLAS Color Tokens

## Scope and adapter boundary

Color tokens are separate ATLAS game_entitlement products mapped to one token kind: ship, tame, or armor. They are player-applied operations, not automatic game rewards.

Core stores the player's selected color as opaque JSON (maximum 4 KiB). Core does not define color IDs, RGB ranges, asset identifiers, or native game callbacks. The installed ATLAS adapter must validate the selected color against the live game API, verify target ownership and permissions on the requested server, apply the change, and then acknowledge the operation.

A color-token product must not have a row in commerce.product_game_mappings. Database triggers enforce this separation so fulfillment cannot also enqueue an automatic reward for a player-applied token.

## Product setup

Create the product as game_entitlement, then map it to exactly one token kind:

~~~sql
INSERT INTO commerce.atlas_color_token_products (product_id, token_kind)
VALUES ('<product-uuid>', 'ship'); -- ship | tame | armor
~~~

The product mapping is the source of the token kind. The player cannot choose or override it in an application request. Do not create an automatic product_game_mappings row for the same product.

Existing paid-order fulfillment grants the entitlement quantity from the order item. Duplicate payment/webhook processing remains handled by the existing order-item and fulfillment idempotency constraints.

## Player API

### Submit an application

POST /account/atlas/color-token-applications

Headers:

- Authorization: Bearer <player-session>
- Idempotency-Key: <8-128 characters>

Body:

~~~json
{
  "entitlementId": "<entitlement-uuid>",
  "assetId": "<adapter-defined asset identifier>",
  "scope": {
    "serverId": "<server-uuid>",
    "clusterId": "<cluster-uuid>",
    "gridId": "<registered ATLAS grid key>"
  },
  "selectedColor": "<opaque adapter-defined JSON value>"
}
~~~

The selected color may be any non-null JSON value up to 4 KiB. Its exact structure is adapter-specific and is deliberately not interpreted by Core.

Core requires:

- An authenticated player with a verified, linked Steam account.
- An active color-token entitlement belonging to that player.
- A paid order with a succeeded, verified payment transaction.
- A registered ATLAS server, cluster, and grid combination.
- An unused token use in the entitlement quantity.

A new application returns 202 with an application ID and pending status. Repeating the same request with the same idempotency key returns the existing operation. Reusing the key with a different request returns 409 IDEMPOTENCY_CONFLICT.

Pending and processing applications reserve a token use. A successful adapter acknowledgement consumes exactly one use. A failed acknowledgement releases the reservation; failed applications do not consume tokens.

### Read application status

GET /account/atlas/color-token-applications/:applicationId

Only the player who submitted the operation can read its status.

## Server adapter API

Create a service account with the atlas_color_token_worker role scoped to the specific server. The existing service-account script can create the account, credential, and scoped role assignment:

~~~bash
npm run service:create -- atlas-color-token-worker --role atlas_color_token_worker --scope-type server --scope-id <server-uuid>
~~~

The generated service credential is shown once. Store it securely and never log it.

### Claim operations

POST /integrations/servers/:serverId/atlas/color-token-applications/claim

Requires atlas.color_tokens.claim at the matching server scope.

Body:

~~~json
{ "limit": 10 }
~~~

The response contains the operation ID, entitlement ID, token kind, verified owner Steam ID, target asset ID, selected color value, server scope, lease token, and lease expiry.

The lease duration is 120 seconds. Expired processing leases can be reclaimed. A reclaimed operation keeps the same application ID but receives a new lease token.

### Acknowledge an outcome

POST /integrations/servers/:serverId/atlas/color-token-applications/:applicationId/ack

Requires atlas.color_tokens.ack at the matching server scope.

Success:

~~~json
{
  "leaseToken": "<current-lease-uuid>",
  "outcome": "applied"
}
~~~

Failure:

~~~json
{
  "leaseToken": "<current-lease-uuid>",
  "outcome": "failed",
  "errorCode": "COLOR_UNSUPPORTED"
}
~~~

Failure codes must match ^[A-Z0-9_.-]{1,100}$. Do not send free-form error messages, credentials, or secrets.

Acknowledgements are fenced by the current lease token and service identity. Repeating the same final outcome is idempotent; attempting to change a final outcome returns a conflict.

## Adapter requirements

The native adapter must:

1. Treat the Core application ID as the idempotency key for the game-side action. Persist processed IDs so a lease retry cannot apply the same change twice.
2. Verify the Steam owner, server, target asset ownership, target permissions, and asset kind against the live game API.
3. Validate the opaque selected-color value against the actual game API's supported representation.
4. Apply the change only after those checks pass.
5. Acknowledge applied only after the game confirms success. Otherwise acknowledge failed with a sanitized error code.
6. Never log service credentials, lease tokens, or other secrets.

Core does not perform a native color change and does not treat a submitted request or a claimed operation as successful. Native API integration remains a separate adapter implementation task.
