import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import Fastify from "fastify";
import { pool } from "../dist/db.js";
import { hashToken } from "../dist/auth/session.js";
import { registerCommerceRoutes } from "../dist/routes/commerce.js";
import { registerPaymentRoutes } from "../dist/routes/payments.js";

test("wallet top-ups and wallet-funded orders are atomic and idempotent", {
  skip: !pool
    ? "DATABASE_URL is not configured"
    : !(process.env.STRIPE_WEBHOOK_SECRET ?? "").startsWith("whsec_")
      ? "STRIPE_WEBHOOK_SECRET is not configured"
      : false
}, async () => {
  const app = Fastify();
  await registerCommerceRoutes(app);
  await registerPaymentRoutes(app);

  const ids = {
    player: randomUUID(),
    admin: randomUUID(),
    cluster: randomUUID(),
    server: randomUUID(),
    gameProduct: randomUUID(),
    insufficientProduct: randomUUID(),
    unconfiguredPack: randomUUID()
  };
  const orderIds = [];
  const productIds = [ids.gameProduct, ids.insufficientProduct, ids.unconfiguredPack];
  const suffix = randomUUID();
  const playerToken = randomBytes(32).toString("base64url");
  const adminToken = randomBytes(32).toString("base64url");
  const steamId = "7656119" + String(1_000_000_000 + Math.floor(Math.random() * 8_999_999_999));
  const stripeSessionId = "cs_test_" + randomUUID().replaceAll("-", "");
  const webhookEventIds = ["evt_wallet_topup_" + suffix, "evt_wallet_topup_retry_" + suffix];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  try {
    for (const [id, username] of [
      [ids.player, "wallet_player_" + suffix.slice(0, 12)],
      [ids.admin, "wallet_admin_" + suffix.slice(0, 12)]
    ]) {
      await pool.query("INSERT INTO core.principals (id, principal_type, status) VALUES ($1, 'user', 'active')", [id]);
      await pool.query("INSERT INTO core.users (principal_id, username) VALUES ($1, $2)", [id, username]);
    }
    await pool.query(
      "INSERT INTO core.auth_sessions (principal_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 hour'), ($3, $4, NOW() + INTERVAL '1 hour')",
      [ids.player, hashToken(playerToken), ids.admin, hashToken(adminToken)]
    );
    await pool.query(
      "INSERT INTO core.principal_role_assignments (principal_id, role_id, scope_type, scope_id) SELECT $1, id, 'platform', NULL FROM core.roles WHERE role_key = 'platform_admin'",
      [ids.admin]
    );
    await pool.query(
      "INSERT INTO core.linked_accounts (principal_id, provider, external_id, verified_at) VALUES ($1, 'steam', $2, NOW())",
      [ids.player, steamId]
    );
    await pool.query(
      "INSERT INTO core.clusters (id, game_key, name, status) VALUES ($1, 'atlas', $2, 'active')",
      [ids.cluster, "Wallet test cluster " + suffix.slice(0, 8)]
    );
    await pool.query(
      "INSERT INTO core.servers (id, cluster_id, game_key, name, environment, status) VALUES ($1, $2, 'atlas', $3, 'test', 'offline')",
      [ids.server, ids.cluster, "Wallet test server " + suffix.slice(0, 8)]
    );

    const adminHeaders = { authorization: "Bearer " + adminToken };
    const playerHeaders = { authorization: "Bearer " + playerToken };
    const packCreate = await app.inject({
      method: "POST",
      url: "/admin/commerce/products",
      headers: adminHeaders,
      payload: {
        sku: "wallet-pack-" + suffix.slice(0, 12),
        name: "Wallet pack test",
        productType: "currency_pack",
        status: "active",
        currency: "USD",
        amountMinor: 1000
      }
    });
    assert.equal(packCreate.statusCode, 201, packCreate.body);
    const packProductId = packCreate.json().data.productId;
    productIds.push(packProductId);

    const mapping = await app.inject({
      method: "PUT",
      url: "/admin/commerce/products/" + packProductId + "/wallet-mapping",
      headers: adminHeaders,
      payload: { currencyCode: "ATK", creditAmountMinor: "500" }
    });
    assert.equal(mapping.statusCode, 200, mapping.body);
    assert.equal(mapping.json().data.currencyCode, "ATK");
    assert.equal(mapping.json().data.creditAmountMinor, "500");

    const adminList = await app.inject({ method: "GET", url: "/admin/commerce/products", headers: adminHeaders });
    assert.equal(adminList.statusCode, 200);
    const listedPack = adminList.json().data.find((product) => product.id === packProductId);
    assert.equal(listedPack.walletMapping.currencyCode, "ATK");
    assert.equal(listedPack.walletMapping.creditAmountMinor, "500");

    const catalog = await app.inject({ method: "GET", url: "/catalog/products?currency=USD" });
    assert.equal(catalog.statusCode, 200);
    const catalogPack = catalog.json().data.find((product) => product.id === packProductId);
    assert.equal(catalogPack.walletCreditCurrency, "ATK");
    assert.equal(catalogPack.walletCreditAmountMinor, "500");

    await pool.query(
      "INSERT INTO commerce.products (id, sku, name, product_type, status) VALUES ($1, $2, 'Unconfigured wallet pack', 'currency_pack', 'active')",
      [ids.unconfiguredPack, "wallet-pack-unconfigured-" + suffix.slice(0, 8)]
    );
    await pool.query(
      "INSERT INTO commerce.product_prices (product_id, currency, amount_minor) VALUES ($1, 'USD', 100)",
      [ids.unconfiguredPack]
    );
    const hiddenCatalog = await app.inject({ method: "GET", url: "/catalog/products?currency=USD" });
    assert.equal(hiddenCatalog.json().data.some((product) => product.id === ids.unconfiguredPack), false);
    const unconfiguredOrder = await app.inject({
      method: "POST",
      url: "/commerce/orders",
      headers: { ...playerHeaders, "idempotency-key": "unconfigured-" + suffix },
      payload: { currency: "USD", items: [{ productId: ids.unconfiguredPack, quantity: 1 }] }
    });
    assert.equal(unconfiguredOrder.statusCode, 409);
    assert.equal(unconfiguredOrder.json().error.code, "PRODUCT_CONFIGURATION_INVALID");

    const packOrder = await app.inject({
      method: "POST",
      url: "/commerce/orders",
      headers: { ...playerHeaders, "idempotency-key": "pack-order-" + suffix },
      payload: { currency: "USD", items: [{ productId: packProductId, quantity: 2 }] }
    });
    assert.equal(packOrder.statusCode, 201, packOrder.body);
    const packOrderId = packOrder.json().data.orderId;
    orderIds.push(packOrderId);
    const packItem = await pool.query(
      "SELECT id, wallet_credit_currency, wallet_credit_unit_minor::text AS wallet_credit_unit_minor FROM commerce.order_items WHERE order_id = $1",
      [packOrderId]
    );
    assert.equal(packItem.rows.length, 1);
    assert.equal(packItem.rows[0].wallet_credit_currency, "ATK");
    assert.equal(packItem.rows[0].wallet_credit_unit_minor, "500");

    await pool.query("UPDATE commerce.orders SET status = 'awaiting_payment' WHERE id = $1", [packOrderId]);
    await pool.query(
      "INSERT INTO commerce.payment_transactions (order_id, provider, provider_transaction_id, status, amount_minor, currency, checkout_url, expires_at) VALUES ($1, 'stripe', $2, 'pending', 2000, 'USD', 'https://checkout.example.test', NOW() + INTERVAL '1 hour')",
      [packOrderId, stripeSessionId]
    );
    const sendWebhook = async (eventId) => {
      const rawBody = JSON.stringify({
        id: eventId,
        type: "checkout.session.completed",
        livemode: false,
        data: { object: { id: stripeSessionId, payment_status: "paid", amount_total: 2000, currency: "usd" } }
      });
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = createHmac("sha256", webhookSecret).update(String(timestamp) + "." + rawBody).digest("hex");
      return app.inject({
        method: "POST",
        url: "/webhooks/stripe",
        headers: { "content-type": "application/json", "stripe-signature": "t=" + timestamp + ",v1=" + signature },
        payload: rawBody
      });
    };
    const firstWebhook = await sendWebhook(webhookEventIds[0]);
    assert.equal(firstWebhook.statusCode, 200, firstWebhook.body);
    assert.equal(firstWebhook.json().processed, true);
    const duplicateWebhook = await sendWebhook(webhookEventIds[0]);
    assert.equal(duplicateWebhook.statusCode, 200);
    assert.equal(duplicateWebhook.json().duplicate, true);
    const repeatedSessionWebhook = await sendWebhook(webhookEventIds[1]);
    assert.equal(repeatedSessionWebhook.statusCode, 200);
    assert.equal(repeatedSessionWebhook.json().processed, true);

    const topUpLedger = await pool.query(
      "SELECT entry_type, amount_minor::text AS amount_minor FROM commerce.wallet_ledger WHERE wallet_id IN (SELECT id FROM commerce.wallets WHERE principal_id = $1 AND currency_code = 'ATK') ORDER BY created_at",
      [ids.player]
    );
    assert.equal(topUpLedger.rows.length, 1);
    assert.equal(topUpLedger.rows[0].entry_type, "credit");
    assert.equal(topUpLedger.rows[0].amount_minor, "1000");
    const packEntitlements = await pool.query(
      "SELECT COUNT(*)::int AS count FROM commerce.entitlements WHERE order_item_id = $1",
      [packItem.rows[0].id]
    );
    assert.equal(packEntitlements.rows[0].count, 0);
    const blockedRemap = await app.inject({
      method: "PUT",
      url: "/admin/commerce/products/" + packProductId + "/wallet-mapping",
      headers: adminHeaders,
      payload: { currencyCode: "BOL", creditAmountMinor: "500" }
    });
    assert.equal(blockedRemap.statusCode, 409);
    assert.equal(blockedRemap.json().error.code, "WALLET_CURRENCY_IN_USE");

    await pool.query(
      "INSERT INTO commerce.products (id, sku, name, product_type, status) VALUES ($1, $2, 'ATLAS game item', 'game_entitlement', 'active')",
      [ids.gameProduct, "atlas-wallet-item-" + suffix.slice(0, 12)]
    );
    await pool.query("INSERT INTO commerce.product_prices (product_id, currency, amount_minor) VALUES ($1, 'ATK', 700)", [ids.gameProduct]);
    await pool.query(
      "INSERT INTO commerce.product_game_mappings (product_id, game_key, server_id, delivery_type, delivery_payload) VALUES ($1, 'atlas', $2, 'grant_item', $3::jsonb)",
      [ids.gameProduct, ids.server, JSON.stringify({ itemKey: "test-item" })]
    );
    const externalOrder = await app.inject({
      method: "POST",
      url: "/commerce/orders",
      headers: { ...playerHeaders, "idempotency-key": "external-order-" + suffix },
      payload: { currency: "ATK", items: [{ productId: ids.gameProduct, quantity: 1 }] }
    });
    assert.equal(externalOrder.statusCode, 201, externalOrder.body);
    const externalOrderId = externalOrder.json().data.orderId;
    orderIds.push(externalOrderId);
    const externalSessionId = "cs_test_external_" + randomUUID().replaceAll("-", "");
    await pool.query(
      "INSERT INTO commerce.payment_transactions (order_id, provider, provider_transaction_id, status, amount_minor, currency, checkout_url, expires_at) VALUES ($1, 'stripe', $2, 'pending', 700, 'ATK', 'https://checkout.example.test', NOW() + INTERVAL '1 hour')",
      [externalOrderId, externalSessionId]
    );
    const blockedExternalPayment = await app.inject({
      method: "POST",
      url: "/commerce/orders/" + externalOrderId + "/pay-with-wallet",
      headers: playerHeaders
    });
    assert.equal(blockedExternalPayment.statusCode, 409);
    assert.equal(blockedExternalPayment.json().error.code, "EXTERNAL_PAYMENT_IN_PROGRESS");

    const concurrentOrders = await Promise.all([
      app.inject({
        method: "POST",
        url: "/commerce/orders",
        headers: { ...playerHeaders, "idempotency-key": "game-order-a-" + suffix },
        payload: { currency: "ATK", items: [{ productId: ids.gameProduct, quantity: 1 }] }
      }),
      app.inject({
        method: "POST",
        url: "/commerce/orders",
        headers: { ...playerHeaders, "idempotency-key": "game-order-b-" + suffix },
        payload: { currency: "ATK", items: [{ productId: ids.gameProduct, quantity: 1 }] }
      })
    ]);
    assert.equal(concurrentOrders[0].statusCode, 201, concurrentOrders[0].body);
    assert.equal(concurrentOrders[1].statusCode, 201, concurrentOrders[1].body);
    const concurrentOrderIds = concurrentOrders.map((response) => response.json().data.orderId);
    orderIds.push(...concurrentOrderIds);
    const concurrentPayments = await Promise.all(concurrentOrderIds.map((orderId) => app.inject({
      method: "POST",
      url: "/commerce/orders/" + orderId + "/pay-with-wallet",
      headers: playerHeaders
    })));
    assert.equal(concurrentPayments.filter((response) => response.statusCode === 201).length, 1);
    assert.equal(concurrentPayments.filter((response) => response.statusCode === 409).length, 1);
    const winnerIndex = concurrentPayments.findIndex((response) => response.statusCode === 201);
    const loserIndex = winnerIndex === 0 ? 1 : 0;
    const winnerOrderId = concurrentOrderIds[winnerIndex];
    const loserOrderId = concurrentOrderIds[loserIndex];
    assert.equal(concurrentPayments[winnerIndex].json().data.balanceMinor, "300");
    assert.equal(concurrentPayments[loserIndex].json().error.code, "INSUFFICIENT_WALLET_BALANCE");

    const duplicateWalletPayment = await app.inject({
      method: "POST",
      url: "/commerce/orders/" + winnerOrderId + "/pay-with-wallet",
      headers: playerHeaders
    });
    assert.equal(duplicateWalletPayment.statusCode, 200, duplicateWalletPayment.body);
    assert.equal(duplicateWalletPayment.json().data.reused, true);
    assert.equal(duplicateWalletPayment.json().data.balanceMinor, "300");

    const paidOrder = await pool.query("SELECT status FROM commerce.orders WHERE id = $1", [winnerOrderId]);
    assert.equal(paidOrder.rows[0].status, "paid");
    const loserOrder = await pool.query("SELECT status FROM commerce.orders WHERE id = $1", [loserOrderId]);
    assert.equal(loserOrder.rows[0].status, "pending");
    const walletPaymentRows = await pool.query(
      "SELECT COUNT(*)::int AS count FROM commerce.payment_transactions WHERE order_id = $1 AND provider = 'wallet' AND status = 'succeeded'",
      [winnerOrderId]
    );
    assert.equal(walletPaymentRows.rows[0].count, 1);
    const delivery = await pool.query(
      "SELECT target_external_id, status FROM commerce.reward_queue WHERE entitlement_id IN (SELECT id FROM commerce.entitlements WHERE order_item_id IN (SELECT id FROM commerce.order_items WHERE order_id = $1))",
      [winnerOrderId]
    );
    assert.equal(delivery.rows.length, 1);
    assert.equal(delivery.rows[0].target_external_id, steamId);
    assert.equal(delivery.rows[0].status, "pending");

    await pool.query(
      "INSERT INTO commerce.products (id, sku, name, product_type, status) VALUES ($1, $2, 'Insufficient funds item', 'game_entitlement', 'active')",
      [ids.insufficientProduct, "atlas-wallet-insufficient-" + suffix.slice(0, 10)]
    );
    await pool.query("INSERT INTO commerce.product_prices (product_id, currency, amount_minor) VALUES ($1, 'ATK', 400)", [ids.insufficientProduct]);
    const insufficientOrder = await app.inject({
      method: "POST",
      url: "/commerce/orders",
      headers: { ...playerHeaders, "idempotency-key": "insufficient-" + suffix },
      payload: { currency: "ATK", items: [{ productId: ids.insufficientProduct, quantity: 1 }] }
    });
    assert.equal(insufficientOrder.statusCode, 201, insufficientOrder.body);
    const insufficientOrderId = insufficientOrder.json().data.orderId;
    orderIds.push(insufficientOrderId);
    const insufficientPayment = await app.inject({
      method: "POST",
      url: "/commerce/orders/" + insufficientOrderId + "/pay-with-wallet",
      headers: playerHeaders
    });
    assert.equal(insufficientPayment.statusCode, 409);
    assert.equal(insufficientPayment.json().error.code, "INSUFFICIENT_WALLET_BALANCE");
    const unpaid = await pool.query("SELECT status FROM commerce.orders WHERE id = $1", [insufficientOrderId]);
    assert.equal(unpaid.rows[0].status, "pending");

    await pool.query("INSERT INTO commerce.product_prices (product_id, currency, amount_minor) VALUES ($1, 'ATK', 100)", [packProductId]);
    const packWalletOrder = await app.inject({
      method: "POST",
      url: "/commerce/orders",
      headers: { ...playerHeaders, "idempotency-key": "pack-wallet-" + suffix },
      payload: { currency: "ATK", items: [{ productId: packProductId, quantity: 1 }] }
    });
    assert.equal(packWalletOrder.statusCode, 409);
    assert.equal(packWalletOrder.json().error.code, "CURRENCY_PACK_REQUIRES_EXTERNAL_PAYMENT");

    const wallets = await app.inject({ method: "GET", url: "/account/wallets", headers: playerHeaders });
    assert.equal(wallets.statusCode, 200);
    const atkWallet = wallets.json().data.find((wallet) => wallet.currencyCode === "ATK");
    assert.equal(atkWallet.balanceMinor, "300");
    const ledger = await app.inject({
      method: "GET",
      url: "/account/wallets/ATK/ledger?limit=10",
      headers: playerHeaders
    });
    assert.equal(ledger.statusCode, 200);
    assert.equal(ledger.json().data.length, 2);
    assert.deepEqual(ledger.json().data.map((entry) => entry.entryType).sort(), ["credit", "debit"]);
  } finally {
    await pool.query(
      "DELETE FROM operations.audit_logs WHERE actor_principal_id = ANY($1::uuid[]) OR resource_id = ANY($2::text[])",
      [[ids.player, ids.admin], [...productIds, ...orderIds]]
    );
    await pool.query("DELETE FROM operations.event_outbox WHERE aggregate_id = ANY($1::text[])", [orderIds]);
    await pool.query(
      "DELETE FROM commerce.reward_attempts WHERE reward_id IN (SELECT id FROM commerce.reward_queue WHERE server_id = $1)",
      [ids.server]
    );
    await pool.query("DELETE FROM commerce.reward_queue WHERE server_id = $1", [ids.server]);
    await pool.query("DELETE FROM commerce.entitlements WHERE principal_id = $1", [ids.player]);
    await pool.query(
      "DELETE FROM commerce.payment_webhook_events WHERE provider = 'stripe' AND event_id = ANY($1::text[])",
      [webhookEventIds]
    );
    await pool.query("DELETE FROM commerce.payment_transactions WHERE order_id = ANY($1::uuid[])", [orderIds]);
    await pool.query(
      "DELETE FROM commerce.wallet_ledger WHERE wallet_id IN (SELECT id FROM commerce.wallets WHERE principal_id = $1)",
      [ids.player]
    );
    await pool.query("DELETE FROM commerce.wallets WHERE principal_id = $1", [ids.player]);
    await pool.query("DELETE FROM commerce.order_items WHERE order_id = ANY($1::uuid[])", [orderIds]);
    await pool.query("DELETE FROM commerce.orders WHERE id = ANY($1::uuid[])", [orderIds]);
    await pool.query("DELETE FROM commerce.product_game_mappings WHERE product_id = ANY($1::uuid[])", [productIds]);
    await pool.query("DELETE FROM commerce.product_wallet_mappings WHERE product_id = ANY($1::uuid[])", [productIds]);
    await pool.query("DELETE FROM commerce.product_prices WHERE product_id = ANY($1::uuid[])", [productIds]);
    await pool.query("DELETE FROM commerce.products WHERE id = ANY($1::uuid[])", [productIds]);
    await pool.query("DELETE FROM core.linked_accounts WHERE principal_id = $1", [ids.player]);
    await pool.query("DELETE FROM core.auth_sessions WHERE principal_id = ANY($1::uuid[])", [[ids.player, ids.admin]]);
    await pool.query("DELETE FROM core.principal_role_assignments WHERE principal_id = ANY($1::uuid[])", [[ids.player, ids.admin]]);
    await pool.query("DELETE FROM core.users WHERE principal_id = ANY($1::uuid[])", [[ids.player, ids.admin]]);
    await pool.query("DELETE FROM core.principals WHERE id = ANY($1::uuid[])", [[ids.player, ids.admin]]);
    await pool.query("DELETE FROM core.servers WHERE id = $1", [ids.server]);
    await pool.query("DELETE FROM core.clusters WHERE id = $1", [ids.cluster]);
    await app.close();
    await pool.end();
  }
});
