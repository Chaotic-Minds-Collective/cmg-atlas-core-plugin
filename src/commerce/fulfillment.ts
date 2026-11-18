import type { PoolClient } from "pg";

export async function fulfillPaidOrder(client: PoolClient, orderId: string): Promise<void> {
  const order = await client.query<{ status: string }>(
    "SELECT status FROM commerce.orders WHERE id = $1 FOR UPDATE",
    [orderId]
  );
  if (order.rows[0]?.status !== "paid") {
    throw new Error("Paid-order fulfillment requires an order in the paid state.");
  }

  const invalidCurrencyPacks = await client.query(
    `SELECT oi.id
       FROM commerce.order_items oi
       JOIN commerce.products p ON p.id = oi.product_id
      WHERE oi.order_id = $1
        AND p.product_type = 'currency_pack'
        AND (oi.wallet_credit_currency IS NULL OR oi.wallet_credit_unit_minor IS NULL)`,
    [orderId]
  );
  if (invalidCurrencyPacks.rowCount) {
    throw new Error("A paid currency-pack order is missing its wallet credit snapshot.");
  }

  await client.query(
    `INSERT INTO commerce.wallets (principal_id, currency_code)
     SELECT DISTINCT o.principal_id, oi.wallet_credit_currency
       FROM commerce.orders o
       JOIN commerce.order_items oi ON oi.order_id = o.id
      WHERE o.id = $1 AND oi.wallet_credit_currency IS NOT NULL
     ON CONFLICT (principal_id, currency_code) DO NOTHING`,
    [orderId]
  );
  await client.query(
    `SELECT w.id
       FROM commerce.wallets w
       JOIN commerce.orders o ON o.principal_id = w.principal_id
       JOIN commerce.order_items oi ON oi.order_id = o.id AND oi.wallet_credit_currency = w.currency_code
      WHERE o.id = $1
      ORDER BY w.currency_code
      FOR UPDATE OF w`,
    [orderId]
  );
  await client.query(
    `INSERT INTO commerce.wallet_ledger (wallet_id, entry_type, amount_minor, reference_type, reference_id, idempotency_key)
     SELECT w.id, 'credit', oi.wallet_credit_unit_minor * oi.quantity,
            'currency_pack_order_item', oi.id::text, 'currency-pack-order-item:' || oi.id::text
       FROM commerce.orders o
       JOIN commerce.order_items oi ON oi.order_id = o.id
       JOIN commerce.wallets w ON w.principal_id = o.principal_id AND w.currency_code = oi.wallet_credit_currency
      WHERE o.id = $1 AND oi.wallet_credit_currency IS NOT NULL
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [orderId]
  );
  await client.query(
    `INSERT INTO commerce.entitlements (principal_id, product_id, order_item_id, quantity, status)
     SELECT o.principal_id, oi.product_id, oi.id, oi.quantity, 'active'
       FROM commerce.orders o
       JOIN commerce.order_items oi ON oi.order_id = o.id
       JOIN commerce.products p ON p.id = oi.product_id
      WHERE o.id = $1 AND p.product_type <> 'currency_pack'
     ON CONFLICT (order_item_id) WHERE order_item_id IS NOT NULL DO NOTHING`,
    [orderId]
  );
  await client.query(
    `INSERT INTO commerce.reward_queue (entitlement_id, game_key, server_id, target_external_id, delivery_payload, idempotency_key)
     SELECT e.id, pgm.game_key, pgm.server_id, la.external_id,
            jsonb_build_object('deliveryType', pgm.delivery_type, 'productSku', oi.sku_snapshot,
                               'productName', oi.name_snapshot, 'quantity', oi.quantity,
                               'mapping', pgm.delivery_payload),
            'order_item:' || oi.id::text || ':' || pgm.game_key
       FROM commerce.order_items oi
       JOIN commerce.products p ON p.id = oi.product_id AND p.product_type <> 'currency_pack'
       JOIN commerce.entitlements e ON e.order_item_id = oi.id
       JOIN commerce.product_game_mappings pgm ON pgm.product_id = oi.product_id AND pgm.server_id IS NOT NULL
       JOIN core.servers s ON s.id = pgm.server_id AND s.game_key = pgm.game_key
       JOIN core.linked_accounts la ON la.principal_id = e.principal_id AND la.provider = 'steam'
                                    AND la.verified_at IS NOT NULL AND la.unlinked_at IS NULL
      WHERE oi.order_id = $1
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [orderId]
  );
}
