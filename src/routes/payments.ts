import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requirePrincipal } from "../auth/session.js";
import { config } from "../config.js";
import { pool } from "../db.js";
import { fulfillPaidOrder } from "../commerce/fulfillment.js";
import {
  createStripeCheckoutSession,
  stripeCheckoutEnabled,
  verifyStripeSignature
} from "../payments/stripe.js";

type RawBodyRequest = FastifyRequest & { rawBody?: Buffer };

const orderParamsSchema = z.object({ orderId: z.string().uuid() });
const stripeEventSchema = z.object({
  id: z.string().min(1).max(255),
  type: z.string().min(1).max(160),
  livemode: z.boolean(),
  data: z.object({ object: z.record(z.string(), z.unknown()) })
});

export async function registerPaymentRoutes(app: FastifyInstance): Promise<void> {
  app.get("/commerce/checkout/status", async () => ({
    data: { enabled: stripeCheckoutEnabled(), provider: "stripe", mode: "test" }
  }));

  app.post("/commerce/orders/:orderId/checkout", async (request, reply) => {
    if (!pool) return reply.code(503).send({ error: { code: "DATABASE_UNAVAILABLE", message: "Checkout is temporarily unavailable." } });
    const principalId = await requirePrincipal(request, reply);
    if (!principalId) return;

    const params = orderParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: { code: "INVALID_ORDER_ID", message: "A valid order ID is required." } });
    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      return reply.code(400).send({ error: { code: "IDEMPOTENCY_KEY_REQUIRED", message: "Provide an Idempotency-Key header between 8 and 128 characters." } });
    }
    if (!stripeCheckoutEnabled()) {
      return reply.code(503).send({ error: { code: "CHECKOUT_DISABLED", message: "Test-mode checkout is not configured." } });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const orderResult = await client.query<{
        id: string; principal_id: string; status: string; currency: string; total_minor: string;
      }>(
        "SELECT id, principal_id, status, currency, total_minor::text AS total_minor FROM commerce.orders WHERE id = $1 AND principal_id = $2 FOR UPDATE",
        [params.data.orderId, principalId]
      );
      const order = orderResult.rows[0];
      if (!order) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: { code: "ORDER_NOT_FOUND", message: "The order was not found." } });
      }
      if (order.status === "paid") {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: { code: "ORDER_ALREADY_PAID", message: "This order has already been paid." } });
      }
      if (!["pending", "awaiting_payment"].includes(order.status)) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: { code: "ORDER_NOT_PAYABLE", message: "This order cannot be checked out." } });
      }

      const walletCurrency = await client.query(
        "SELECT 1 FROM commerce.product_wallet_mappings WHERE currency_code = $1 LIMIT 1",
        [order.currency.trim().toUpperCase()]
      );
      if (walletCurrency.rowCount) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: { code: "WALLET_CURRENCY_REQUIRES_WALLET_PAYMENT", message: "Orders priced in a wallet currency must be paid from the account wallet." } });
      }

      const existing = await client.query<{ provider_transaction_id: string; checkout_url: string; expires_at: Date | null }>(
        "SELECT provider_transaction_id, checkout_url, expires_at FROM commerce.payment_transactions WHERE order_id = $1 AND provider = 'stripe' AND status IN ('created', 'pending') AND checkout_url IS NOT NULL AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY created_at DESC LIMIT 1",
        [order.id]
      );
      if (existing.rows[0]) {
        await client.query("COMMIT");
        return {
          data: {
            checkoutUrl: existing.rows[0].checkout_url,
            sessionId: existing.rows[0].provider_transaction_id,
            expiresAt: existing.rows[0].expires_at
          },
          requestId: request.id
        };
      }

      const expiredAttempt = await client.query<{ provider_transaction_id: string }>(
        "SELECT provider_transaction_id FROM commerce.payment_transactions WHERE order_id = $1 AND provider = 'stripe' AND status IN ('created', 'pending', 'failed') AND checkout_url IS NOT NULL AND (status = 'failed' OR (expires_at IS NOT NULL AND expires_at <= NOW())) ORDER BY created_at DESC LIMIT 1",
        [order.id]
      );
      const providerIdempotencyKey = expiredAttempt.rows[0]
        ? "checkout-replacement:" + createHash("sha256").update(idempotencyKey).update(":" + expiredAttempt.rows[0].provider_transaction_id).digest("hex")
        : idempotencyKey;

      const itemResult = await client.query<{
        name_snapshot: string; quantity: number; unit_amount_minor: string;
      }>(
        "SELECT name_snapshot, quantity, unit_amount_minor::text AS unit_amount_minor FROM commerce.order_items WHERE order_id = $1 ORDER BY id",
        [order.id]
      );
      if (!itemResult.rows.length || BigInt(order.total_minor) <= 0n) {
        await client.query("ROLLBACK");
        return reply.code(400).send({ error: { code: "ORDER_HAS_NO_PAYABLE_ITEMS", message: "The order has no payable items." } });
      }

      const session = await createStripeCheckoutSession({
        orderId: order.id,
        principalId,
        currency: order.currency.trim(),
        idempotencyKey: providerIdempotencyKey,
        lines: itemResult.rows.map((item) => ({
          name: item.name_snapshot,
          quantity: item.quantity,
          unitAmountMinor: item.unit_amount_minor
        }))
      });

      await client.query(
        "INSERT INTO commerce.payment_transactions (order_id, provider, provider_transaction_id, status, amount_minor, currency, checkout_url, expires_at) VALUES ($1, 'stripe', $2, 'pending', $3, $4, $5, $6) ON CONFLICT (provider, provider_transaction_id) DO UPDATE SET status = 'pending', checkout_url = EXCLUDED.checkout_url, expires_at = EXCLUDED.expires_at",
        [order.id, session.id, order.total_minor, order.currency, session.url, session.expiresAt]
      );
      await client.query(
        "UPDATE commerce.orders SET status = 'awaiting_payment', updated_at = NOW() WHERE id = $1 AND status IN ('pending', 'awaiting_payment')",
        [order.id]
      );
      await client.query("COMMIT");
      return reply.code(201).send({
        data: { checkoutUrl: session.url, sessionId: session.id, expiresAt: session.expiresAt },
        requestId: request.id
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      request.log.error({ err: error }, "Stripe checkout session creation failed");
      return reply.code(502).send({ error: { code: "CHECKOUT_PROVIDER_UNAVAILABLE", message: "The test checkout session could not be created. No payment was taken." } });
    } finally {
      client.release();
    }
  });

  app.post("/commerce/orders/:orderId/pay-with-wallet", async (request, reply) => {
    if (!pool) return reply.code(503).send({ error: { code: "DATABASE_UNAVAILABLE", message: "Wallet checkout is temporarily unavailable." } });
    const principalId = await requirePrincipal(request, reply);
    if (!principalId) return;
    const params = orderParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: { code: "INVALID_ORDER_ID", message: "A valid order ID is required." } });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const orderResult = await client.query<{
        id: string; principal_id: string; status: string; currency: string; total_minor: string;
      }>(
        "SELECT id, principal_id, status, currency, total_minor::text AS total_minor FROM commerce.orders WHERE id = $1 AND principal_id = $2 FOR UPDATE",
        [params.data.orderId, principalId]
      );
      const order = orderResult.rows[0];
      if (!order) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: { code: "ORDER_NOT_FOUND", message: "The order was not found." } });
      }

      if (order.status === "paid") {
        const existingPayment = await client.query(
          "SELECT id FROM commerce.payment_transactions WHERE order_id = $1 AND provider = 'wallet' AND status = 'succeeded' LIMIT 1",
          [order.id]
        );
        if (existingPayment.rowCount) {
          const balance = await client.query<{ balance_minor: string }>(
            `SELECT COALESCE(SUM(CASE WHEN entry_type IN ('credit', 'refund', 'adjustment') THEN amount_minor ELSE -amount_minor END), 0)::text AS balance_minor
               FROM commerce.wallet_ledger l JOIN commerce.wallets w ON w.id = l.wallet_id
              WHERE w.principal_id = $1 AND w.currency_code = $2`,
            [principalId, order.currency.trim().toUpperCase()]
          );
          await client.query("COMMIT");
          return { data: { orderId: order.id, status: "paid", provider: "wallet", balanceMinor: balance.rows[0]?.balance_minor ?? "0", reused: true }, requestId: request.id };
        }
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: { code: "ORDER_ALREADY_PAID", message: "This order has already been paid by another payment method." } });
      }
      if (order.status !== "pending") {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: { code: "ORDER_NOT_PAYABLE", message: "Only pending orders can be paid from a wallet. Resolve or expire any external checkout first." } });
      }

      const walletCurrency = await client.query(
        "SELECT 1 FROM commerce.product_wallet_mappings WHERE currency_code = $1 LIMIT 1",
        [order.currency.trim().toUpperCase()]
      );
      if (!walletCurrency.rowCount) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: { code: "WALLET_CURRENCY_NOT_CONFIGURED", message: "The order currency is not configured as a wallet currency." } });
      }
      const currencyPack = await client.query(
        "SELECT 1 FROM commerce.order_items oi JOIN commerce.products p ON p.id = oi.product_id WHERE oi.order_id = $1 AND p.product_type = 'currency_pack' LIMIT 1",
        [order.id]
      );
      if (currencyPack.rowCount) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: { code: "CURRENCY_PACK_WALLET_PAYMENT_FORBIDDEN", message: "Currency packs must be purchased through the configured external payment provider." } });
      }
      const externalPayment = await client.query(
        "SELECT 1 FROM commerce.payment_transactions WHERE order_id = $1 AND provider = 'stripe' AND status IN ('created', 'pending', 'succeeded') LIMIT 1",
        [order.id]
      );
      if (externalPayment.rowCount) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: { code: "EXTERNAL_PAYMENT_IN_PROGRESS", message: "An external payment attempt exists for this order. Wait for its verified result before using the wallet." } });
      }

      const total = BigInt(order.total_minor);
      if (total <= 0n) {
        await client.query("ROLLBACK");
        return reply.code(400).send({ error: { code: "ORDER_HAS_NO_PAYABLE_ITEMS", message: "Wallet checkout requires a positive order total." } });
      }
      await client.query(
        "INSERT INTO commerce.wallets (principal_id, currency_code) VALUES ($1, $2) ON CONFLICT (principal_id, currency_code) DO NOTHING",
        [principalId, order.currency.trim().toUpperCase()]
      );
      const wallet = await client.query<{ id: string }>(
        "SELECT id FROM commerce.wallets WHERE principal_id = $1 AND currency_code = $2 FOR UPDATE",
        [principalId, order.currency.trim().toUpperCase()]
      );
      if (!wallet.rows[0]) throw new Error("Wallet row could not be created or locked.");
      const balanceResult = await client.query<{ balance_minor: string }>(
        `SELECT COALESCE(SUM(CASE WHEN entry_type IN ('credit', 'refund', 'adjustment') THEN amount_minor ELSE -amount_minor END), 0)::text AS balance_minor
           FROM commerce.wallet_ledger WHERE wallet_id = $1`,
        [wallet.rows[0].id]
      );
      const balance = BigInt(balanceResult.rows[0]?.balance_minor ?? "0");
      if (balance < total) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: { code: "INSUFFICIENT_WALLET_BALANCE", message: "The wallet balance is not sufficient for this order." } });
      }

      const debit = await client.query(
        `INSERT INTO commerce.wallet_ledger (wallet_id, entry_type, amount_minor, reference_type, reference_id, idempotency_key)
         VALUES ($1, 'debit', $2, 'order', $3, $4)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [wallet.rows[0].id, total.toString(), order.id, "wallet-order:" + order.id]
      );
      if (!debit.rowCount) throw new Error("The wallet order debit idempotency key already exists for an unpaid order.");

      const payment = await client.query<{ id: string }>(
        `INSERT INTO commerce.payment_transactions (order_id, provider, provider_transaction_id, status, amount_minor, currency, verified_at)
         VALUES ($1, 'wallet', $2, 'succeeded', $3, $4, NOW())
         ON CONFLICT (provider, provider_transaction_id) DO NOTHING
         RETURNING id`,
        [order.id, "wallet-order:" + order.id, total.toString(), order.currency]
      );
      if (!payment.rows[0]) throw new Error("The wallet payment transaction already exists for an unpaid order.");
      const paid = await client.query(
        "UPDATE commerce.orders SET status = 'paid', updated_at = NOW() WHERE id = $1 AND status = 'pending' RETURNING id",
        [order.id]
      );
      if (!paid.rowCount) throw new Error("The order state changed before wallet payment could be committed.");

      await fulfillPaidOrder(client, order.id);
      await client.query(
        "INSERT INTO operations.event_outbox (event_type, aggregate_type, aggregate_id, payload) VALUES ('commerce.order.paid', 'order', $1, $2::jsonb)",
        [order.id, JSON.stringify({ orderId: order.id, principalId, paymentTransactionId: payment.rows[0].id, provider: "wallet" })]
      );
      await client.query(
        "INSERT INTO operations.audit_logs (actor_principal_id, action, resource_type, resource_id, outcome, metadata) VALUES ($1, 'payment.wallet.succeeded', 'order', $2, 'success', $3::jsonb)",
        [principalId, order.id, JSON.stringify({ paymentTransactionId: payment.rows[0].id, currency: order.currency, amountMinor: total.toString() })]
      );
      await client.query("COMMIT");
      return reply.code(201).send({
        data: { orderId: order.id, status: "paid", provider: "wallet", balanceMinor: (balance - total).toString(), reused: false },
        requestId: request.id
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      request.log.error({ err: error }, "Wallet order payment failed");
      return reply.code(500).send({ error: { code: "WALLET_PAYMENT_FAILED", message: "The order could not be paid from the wallet." } });
    } finally {
      client.release();
    }
  });

  app.post("/webhooks/stripe", {
    preParsing: async (request, _reply, payload) => {
      const chunks: Buffer[] = [];
      const bodyLimit = request.routeOptions.bodyLimit ?? request.server.initialConfig.bodyLimit ?? 1_048_576;
      let receivedBytes = 0;
      for await (const chunk of payload) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        receivedBytes += buffer.length;
        if (receivedBytes > bodyLimit) {
          const error = new Error("Request body is too large") as Error & { statusCode: number; code: string };
          error.statusCode = 413;
          error.code = "FST_ERR_CTP_BODY_TOO_LARGE";
          throw error;
        }
        chunks.push(buffer);
      }
      const rawBody = Buffer.concat(chunks);
      (request as RawBodyRequest).rawBody = rawBody;
      return Readable.from([rawBody]);
    }
  }, async (request, reply) => {
    if (!pool) return reply.code(503).send({ error: { code: "DATABASE_UNAVAILABLE", message: "Payment webhook processing is unavailable." } });
    if (!config.STRIPE_WEBHOOK_SECRET.startsWith("whsec_")) {
      return reply.code(503).send({ error: { code: "WEBHOOK_NOT_CONFIGURED", message: "Stripe webhook verification is not configured." } });
    }
    const rawBody = (request as RawBodyRequest).rawBody;
    const signatureHeader = request.headers["stripe-signature"];
    const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
    if (!rawBody || !verifyStripeSignature(rawBody, signature, config.STRIPE_WEBHOOK_SECRET)) {
      return reply.code(400).send({ error: { code: "INVALID_WEBHOOK_SIGNATURE", message: "The Stripe signature is invalid or expired." } });
    }

    const parsed = stripeEventSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_WEBHOOK_EVENT", message: "The Stripe event payload is invalid." } });
    const event = parsed.data;
    if (event.livemode !== false) {
      return reply.code(400).send({ error: { code: "LIVE_MODE_EVENT_REJECTED", message: "Only Stripe test-mode events are accepted." } });
    }
    const supportedSuccess = event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded";
    const supportedFailure = event.type === "checkout.session.expired" || event.type === "checkout.session.async_payment_failed";
    if (!supportedSuccess && !supportedFailure) return { received: true, ignored: true };

    const session = event.data.object;
    const sessionId = typeof session.id === "string" ? session.id : null;
    if (!sessionId) return reply.code(400).send({ error: { code: "INVALID_CHECKOUT_SESSION", message: "The Stripe checkout session ID is missing." } });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const duplicate = await client.query(
        "SELECT 1 FROM commerce.payment_webhook_events WHERE provider = 'stripe' AND event_id = $1",
        [event.id]
      );
      if (duplicate.rowCount) {
        await client.query("COMMIT");
        return { received: true, duplicate: true };
      }

      const transactionResult = await client.query<{
        id: string; order_id: string; status: string; amount_minor: string; currency: string; principal_id: string; order_status: string;
      }>(
        "SELECT pt.id, pt.order_id, pt.status, pt.amount_minor::text AS amount_minor, pt.currency, o.principal_id, o.status AS order_status FROM commerce.payment_transactions pt JOIN commerce.orders o ON o.id = pt.order_id WHERE pt.provider = 'stripe' AND pt.provider_transaction_id = $1 FOR UPDATE OF pt, o",
        [sessionId]
      );
      const payment = transactionResult.rows[0];
      if (!payment) {
        await client.query("ROLLBACK");
        return reply.code(500).send({ error: { code: "PAYMENT_TRANSACTION_NOT_FOUND", message: "The checkout session is not registered yet. Stripe may retry this event." } });
      }

      if (supportedSuccess && session.payment_status === "paid" && payment.status !== "succeeded") {
        const amountTotal = typeof session.amount_total === "number" ? session.amount_total : Number.NaN;
        const currency = typeof session.currency === "string" ? session.currency.toUpperCase() : "";
        if (!Number.isSafeInteger(amountTotal) || BigInt(amountTotal) !== BigInt(payment.amount_minor) || currency !== payment.currency.trim().toUpperCase()) {
          await client.query(
            "UPDATE commerce.payment_transactions SET status = 'failed', provider_event_id = $1 WHERE id = $2 AND status <> 'succeeded'",
            [event.id, payment.id]
          );
          await client.query(
            "UPDATE commerce.orders SET status = 'failed', updated_at = NOW() WHERE id = $1 AND status IN ('pending', 'awaiting_payment')",
            [payment.order_id]
          );
          await client.query(
            "INSERT INTO operations.audit_logs (action, resource_type, resource_id, outcome, metadata) VALUES ('payment.stripe.amount_mismatch', 'order', $1, 'failure', $2::jsonb)",
            [payment.order_id, JSON.stringify({ eventId: event.id, paymentTransactionId: payment.id })]
          );
        } else {
          await client.query(
            "UPDATE commerce.payment_transactions SET status = 'succeeded', provider_event_id = $1, verified_at = NOW() WHERE id = $2",
            [event.id, payment.id]
          );
          const orderTransition = await client.query(
            "UPDATE commerce.orders SET status = 'paid', updated_at = NOW() WHERE id = $1 AND status IN ('pending', 'awaiting_payment') RETURNING id",
            [payment.order_id]
          );
          if (orderTransition.rowCount) {
            await fulfillPaidOrder(client, payment.order_id);
            await client.query(
              "INSERT INTO operations.event_outbox (event_type, aggregate_type, aggregate_id, payload) VALUES ('commerce.order.paid', 'order', $1, $2::jsonb)",
              [payment.order_id, JSON.stringify({ orderId: payment.order_id, principalId: payment.principal_id, paymentTransactionId: payment.id, provider: "stripe" })]
            );
            await client.query(
              "INSERT INTO operations.audit_logs (actor_principal_id, action, resource_type, resource_id, outcome, metadata) VALUES (NULL, 'payment.stripe.succeeded', 'order', $1, 'success', $2::jsonb)",
              [payment.order_id, JSON.stringify({ eventId: event.id, paymentTransactionId: payment.id })]
            );
          } else {
            await client.query(
              "INSERT INTO operations.audit_logs (actor_principal_id, action, resource_type, resource_id, outcome, metadata) VALUES (NULL, 'payment.stripe.succeeded_reconciliation', 'order', $1, 'success', $2::jsonb)",
              [payment.order_id, JSON.stringify({ eventId: event.id, paymentTransactionId: payment.id, orderStatus: payment.order_status })]
            );
          }
        }
      } else if (supportedFailure) {
        await client.query(
          "UPDATE commerce.payment_transactions SET status = 'failed', provider_event_id = $1 WHERE id = $2 AND status <> 'succeeded'",
          [event.id, payment.id]
        );
        await client.query(
          "UPDATE commerce.orders o SET status = 'pending', updated_at = NOW() WHERE o.id = $1 AND o.status = 'awaiting_payment' AND NOT EXISTS (SELECT 1 FROM commerce.payment_transactions pt WHERE pt.order_id = o.id AND pt.provider = 'stripe' AND pt.status = 'pending' AND (pt.expires_at IS NULL OR pt.expires_at > NOW()))",
          [payment.order_id]
        );
        await client.query(
          "INSERT INTO operations.audit_logs (actor_principal_id, action, resource_type, resource_id, outcome, metadata) VALUES (NULL, 'payment.stripe.failed', 'order', $1, 'failure', $2::jsonb)",
          [payment.order_id, JSON.stringify({ eventId: event.id, paymentTransactionId: payment.id, eventType: event.type })]
        );
      }

      await client.query(
        "INSERT INTO commerce.payment_webhook_events (provider, event_id, event_type, payment_transaction_id) VALUES ('stripe', $1, $2, $3)",
        [event.id, event.type, payment.id]
      );
      await client.query("COMMIT");
      return { received: true, processed: true };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      request.log.error({ err: error }, "Stripe webhook processing failed");
      return reply.code(500).send({ error: { code: "WEBHOOK_PROCESSING_FAILED", message: "The payment event could not be processed." } });
    } finally {
      client.release();
    }
  });
}
