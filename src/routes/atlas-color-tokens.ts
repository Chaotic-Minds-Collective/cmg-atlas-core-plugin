import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requirePrincipal } from "../auth/session.js";
import { requireServicePermission } from "../auth/service.js";
import { pool } from "../db.js";
import { matchesRewardLeaseToken } from "../rewards/lease.js";

const scopeSchema = z.object({
  clusterId: z.string().uuid().transform((value) => value.toLowerCase()),
  gridId: z.string().trim().min(1).max(200),
  serverId: z.string().uuid().transform((value) => value.toLowerCase())
}).strict();

const selectedColorSchema = z.custom<unknown>((value) => {
  if (value === undefined || value === null) return false;
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" && Buffer.byteLength(serialized, "utf8") <= 4096;
  } catch {
    return false;
  }
});

const applicationSchema = z.object({
  entitlementId: z.string().uuid().transform((value) => value.toLowerCase()),
  assetId: z.string().trim().min(1).max(256),
  scope: scopeSchema,
  // Opaque JSON supplied by the client and validated by the installed game adapter.
  selectedColor: selectedColorSchema
}).strict();

const applicationParamsSchema = z.object({
  applicationId: z.string().uuid().transform((value) => value.toLowerCase())
});

const serverParamsSchema = z.object({
  serverId: z.string().uuid().transform((value) => value.toLowerCase())
});

const claimSchema = z.object({
  limit: z.number().int().min(1).max(20).default(1)
}).strict();

const ackSchema = z.object({
  leaseToken: z.string().uuid(),
  outcome: z.enum(["applied", "failed"]),
  errorCode: z.string().regex(/^[A-Z0-9_.-]{1,100}$/).optional()
}).strict().superRefine((value, context) => {
  if (value.outcome === "failed" && !value.errorCode) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["errorCode"],
      message: "A sanitized error code is required when an application fails."
    });
  }
  if (value.outcome === "applied" && value.errorCode) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["errorCode"],
      message: "A successful application cannot include an error code."
    });
  }
});

function sendError(reply: Parameters<Parameters<FastifyInstance["post"]>[1]>[1], status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message } });
}

export async function registerAtlasColorTokenRoutes(app: FastifyInstance): Promise<void> {
  app.post("/account/atlas/color-token-applications", async (request, reply) => {
    if (!pool) return reply.code(503).send({ error: { code: "DATABASE_UNAVAILABLE", message: "ATLAS color-token applications are temporarily unavailable." } });

    const principalId = await requirePrincipal(request, reply);
    if (!principalId) return;

    const parsed = applicationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "A valid entitlement, target asset, server scope, and color representation are required." } });
    }

    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      return reply.code(400).send({ error: { code: "IDEMPOTENCY_KEY_REQUIRED", message: "Provide an Idempotency-Key header between 8 and 128 characters." } });
    }

    const requestHash = createHash("sha256")
      .update(JSON.stringify(parsed.data))
      .digest("hex");
    const client = await pool.connect();

    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        ["atlas.color_token.application:" + principalId, idempotencyKey]
      );

      const existing = await client.query<{
        id: string;
        request_hash: string;
        status: string;
        token_kind: string;
      }>(
        `SELECT id, request_hash, status, token_kind
           FROM operations.atlas_color_token_applications
          WHERE principal_id = $1 AND idempotency_key = $2
          FOR UPDATE`,
        [principalId, idempotencyKey]
      );

      if (existing.rows[0]) {
        await client.query("ROLLBACK");
        if (existing.rows[0].request_hash !== requestHash) {
          return reply.code(409).send({ error: { code: "IDEMPOTENCY_CONFLICT", message: "This idempotency key was already used for a different color-token application." } });
        }
        return reply.code(200).send({
          data: {
            applicationId: existing.rows[0].id,
            status: existing.rows[0].status,
            tokenKind: existing.rows[0].token_kind,
            duplicate: true
          },
          requestId: request.id
        });
      }

      const steam = await client.query<{ external_id: string }>(
        `SELECT external_id
           FROM core.linked_accounts
          WHERE principal_id = $1
            AND provider = 'steam'
            AND verified_at IS NOT NULL
            AND unlinked_at IS NULL
          ORDER BY linked_at DESC
          LIMIT 1`,
        [principalId]
      );
      const steamId = steam.rows[0]?.external_id;
      if (!steamId) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: { code: "VERIFIED_STEAM_ACCOUNT_REQUIRED", message: "Link and verify a Steam account before applying an ATLAS color token." } });
      }

      const server = await client.query(
        `SELECT s.id
           FROM core.servers s
           JOIN games_atlas.maps m
             ON m.server_id = s.id AND m.cluster_id = s.cluster_id
          WHERE s.id = $1
            AND s.cluster_id = $2
            AND s.game_key = 'atlas'
            AND s.status <> 'deleted'
            AND m.map_key = $3`,
        [parsed.data.scope.serverId, parsed.data.scope.clusterId, parsed.data.scope.gridId]
      );
      if (!server.rowCount) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: { code: "COLOR_TOKEN_SCOPE_MISMATCH", message: "The server, cluster, and ATLAS grid do not match Core's registered topology." } });
      }

      const entitlementResult = await client.query<{
        id: string;
        product_id: string;
        quantity: number;
        token_kind: "ship" | "tame" | "armor";
      }>(
        `SELECT e.id, e.product_id, e.quantity, ctp.token_kind
           FROM commerce.entitlements e
           JOIN commerce.products p
             ON p.id = e.product_id AND p.product_type = 'game_entitlement'
           JOIN commerce.atlas_color_token_products ctp
             ON ctp.product_id = e.product_id
           JOIN commerce.order_items oi
             ON oi.id = e.order_item_id AND oi.product_id = e.product_id
           JOIN commerce.orders o
             ON o.id = oi.order_id AND o.principal_id = e.principal_id
          WHERE e.id = $1
            AND e.principal_id = $2
            AND e.status = 'active'
            AND e.revoked_at IS NULL
            AND o.status = 'paid'
            AND EXISTS (
              SELECT 1
                FROM commerce.payment_transactions pt
               WHERE pt.order_id = o.id
                 AND pt.status = 'succeeded'
                 AND pt.verified_at IS NOT NULL
            )
            AND (e.expires_at IS NULL OR e.expires_at > clock_timestamp())
          FOR UPDATE OF e`,
        [parsed.data.entitlementId, principalId]
      );
      const entitlement = entitlementResult.rows[0];
      if (!entitlement) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: { code: "ACTIVE_PAID_COLOR_TOKEN_REQUIRED", message: "An active color-token entitlement from a verified paid order is required." } });
      }

      const usage = await client.query<{ count: number }>(
        `SELECT COUNT(*)::integer AS count
           FROM operations.atlas_color_token_applications
          WHERE entitlement_id = $1
            AND status IN ('pending', 'processing', 'applied')`,
        [entitlement.id]
      );
      if ((usage.rows[0]?.count ?? 0) >= entitlement.quantity) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: { code: "COLOR_TOKEN_EXHAUSTED", message: "All uses included in this color-token entitlement are already pending or have been applied." } });
      }

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO operations.atlas_color_token_applications
          (principal_id, entitlement_id, product_id, token_kind, owner_external_id,
           server_id, cluster_id, grid_id, asset_id, selected_color,
           idempotency_key, request_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)
         RETURNING id`,
        [
          principalId,
          entitlement.id,
          entitlement.product_id,
          entitlement.token_kind,
          steamId,
          parsed.data.scope.serverId,
          parsed.data.scope.clusterId,
          parsed.data.scope.gridId,
          parsed.data.assetId,
          JSON.stringify(parsed.data.selectedColor),
          idempotencyKey,
          requestHash
        ]
      );
      const applicationId = inserted.rows[0]?.id;
      if (!applicationId) throw new Error("Color-token application insert returned no identifier.");

      await client.query(
        `INSERT INTO operations.audit_logs
          (actor_principal_id, action, resource_type, resource_id, outcome, metadata)
         VALUES ($1, 'atlas.color_token.application.submitted', 'atlas_color_token_application', $2, 'success', $3::jsonb)`,
        [principalId, applicationId, JSON.stringify({
          entitlementId: entitlement.id,
          tokenKind: entitlement.token_kind,
          assetId: parsed.data.assetId,
          serverId: parsed.data.scope.serverId,
          clusterId: parsed.data.scope.clusterId,
          gridId: parsed.data.scope.gridId,
          selectedColor: parsed.data.selectedColor
        })]
      );

      await client.query("COMMIT");
      return reply.code(202).send({
        data: {
          applicationId,
          status: "pending",
          tokenKind: entitlement.token_kind,
          duplicate: false
        },
        requestId: request.id
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
        const duplicate = await client.query<{
          id: string;
          request_hash: string;
          status: string;
          token_kind: string;
        }>(
          `SELECT id, request_hash, status, token_kind
             FROM operations.atlas_color_token_applications
            WHERE principal_id = $1 AND idempotency_key = $2`,
          [principalId, idempotencyKey]
        );
        if (duplicate.rows[0]) {
          if (duplicate.rows[0].request_hash !== requestHash) {
            return reply.code(409).send({ error: { code: "IDEMPOTENCY_CONFLICT", message: "This idempotency key was already used for a different color-token application." } });
          }
          return reply.code(200).send({
            data: {
              applicationId: duplicate.rows[0].id,
              status: duplicate.rows[0].status,
              tokenKind: duplicate.rows[0].token_kind,
              duplicate: true
            },
            requestId: request.id
          });
        }
        return reply.code(409).send({ error: { code: "COLOR_TOKEN_APPLICATION_CONFLICT", message: "The color-token application conflicts with an existing operation." } });
      }
      request.log.error({ err: error }, "ATLAS color-token application submission failed");
      return reply.code(500).send({ error: { code: "COLOR_TOKEN_APPLICATION_FAILED", message: "The color-token application could not be submitted." } });
    } finally {
      client.release();
    }
  });

  app.get("/account/atlas/color-token-applications/:applicationId", async (request, reply) => {
    if (!pool) return reply.code(503).send({ error: { code: "DATABASE_UNAVAILABLE", message: "ATLAS color-token application status is temporarily unavailable." } });
    const principalId = await requirePrincipal(request, reply);
    if (!principalId) return;

    const params = applicationParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "A valid application ID is required." } });
    }

    const result = await pool.query(
      `SELECT id AS "applicationId", token_kind AS "tokenKind",
              asset_id AS "assetId", server_id AS "serverId",
              cluster_id AS "clusterId", grid_id AS "gridId",
              selected_color AS "selectedColor", status,
              error_code AS "errorCode", created_at AS "createdAt",
              applied_at AS "appliedAt"
         FROM operations.atlas_color_token_applications
        WHERE id = $1 AND principal_id = $2`,
      [params.data.applicationId, principalId]
    );
    if (!result.rowCount) {
      return reply.code(404).send({ error: { code: "COLOR_TOKEN_APPLICATION_NOT_FOUND", message: "The color-token application was not found." } });
    }
    return { data: result.rows[0], requestId: request.id };
  });

  app.post("/integrations/servers/:serverId/atlas/color-token-applications/claim", async (request, reply) => {
    if (!pool) return reply.code(503).send({ error: { code: "DATABASE_UNAVAILABLE", message: "ATLAS color-token application delivery is temporarily unavailable." } });

    const params = serverParamsSchema.safeParse(request.params);
    const body = claimSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "A valid server UUID and claim limit are required." } });
    }

    const actorId = await requireServicePermission(request, reply, "atlas.color_tokens.claim", "server", params.data.serverId);
    if (!actorId) return;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const claimed = await client.query(
        `WITH picked AS (
           SELECT a.id
             FROM operations.atlas_color_token_applications a
             JOIN core.servers s ON s.id = a.server_id AND s.game_key = 'atlas'
            WHERE a.server_id = $1
              AND s.status <> 'deleted'
              AND (
                a.status = 'pending'
                OR (a.status = 'processing' AND a.lease_expires_at <= clock_timestamp())
              )
            ORDER BY a.created_at, a.id
            LIMIT $2
            FOR UPDATE OF a SKIP LOCKED
         )
         UPDATE operations.atlas_color_token_applications a
            SET status = 'processing',
                attempts = a.attempts + 1,
                lease_token = gen_random_uuid(),
                claimed_by_principal_id = $3,
                lease_expires_at = clock_timestamp() + INTERVAL '120 seconds',
                updated_at = clock_timestamp()
           FROM picked
          WHERE a.id = picked.id
         RETURNING a.id AS "applicationId",
                   a.entitlement_id AS "entitlementId",
                   a.token_kind AS "tokenKind",
                   a.owner_external_id AS "ownerExternalId",
                   a.asset_id AS "assetId",
                   a.selected_color AS "selectedColor",
                   a.server_id AS "serverId",
                   a.cluster_id AS "clusterId",
                   a.grid_id AS "gridId",
                   a.attempts,
                   a.lease_expires_at AS "leaseExpiresAt",
                   a.lease_token AS "leaseToken"`,
        [params.data.serverId, body.data.limit, actorId]
      );

      await client.query(
        `INSERT INTO operations.audit_logs
          (actor_principal_id, action, resource_type, resource_id, outcome, metadata)
         VALUES ($1, 'atlas.color_token.application.claim', 'server', $2, 'success', $3::jsonb)`,
        [actorId, params.data.serverId, JSON.stringify({ claimedCount: claimed.rows.length })]
      );

      await client.query("COMMIT");
      return { data: claimed.rows, requestId: request.id };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      request.log.error({ err: error }, "ATLAS color-token application claim failed");
      return reply.code(500).send({ error: { code: "COLOR_TOKEN_CLAIM_FAILED", message: "Color-token applications could not be claimed." } });
    } finally {
      client.release();
    }
  });

  app.post("/integrations/servers/:serverId/atlas/color-token-applications/:applicationId/ack", async (request, reply) => {
    if (!pool) return reply.code(503).send({ error: { code: "DATABASE_UNAVAILABLE", message: "ATLAS color-token acknowledgement is temporarily unavailable." } });

    const params = z.object({
      ...serverParamsSchema.shape,
      applicationId: z.string().uuid().transform((value) => value.toLowerCase())
    }).safeParse(request.params);
    const body = ackSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "A valid application ID, lease token, and final outcome are required." } });
    }

    const actorId = await requireServicePermission(request, reply, "atlas.color_tokens.ack", "server", params.data.serverId);
    if (!actorId) return;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<{
        id: string;
        status: string;
        attempts: number;
        claimed_by_principal_id: string | null;
        lease_token: string | null;
        lease_active: boolean;
        entitlement_id: string;
        token_kind: string;
        asset_id: string;
        selected_color: unknown;
      }>(
        `SELECT a.id, a.status, a.attempts, a.claimed_by_principal_id,
                a.lease_token,
                (a.lease_expires_at > clock_timestamp()) AS lease_active,
                a.entitlement_id, a.token_kind, a.asset_id, a.selected_color
           FROM operations.atlas_color_token_applications a
           JOIN core.servers s ON s.id = a.server_id AND s.game_key = 'atlas'
          WHERE a.id = $1 AND a.server_id = $2 AND s.status <> 'deleted'
          FOR UPDATE OF a`,
        [params.data.applicationId, params.data.serverId]
      );
      const application = current.rows[0];
      if (!application) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: { code: "COLOR_TOKEN_APPLICATION_NOT_FOUND", message: "The color-token application was not found for this server." } });
      }

      const finalStatus = body.data.outcome;
      if (application.status === "applied" || application.status === "failed") {
        await client.query("COMMIT");
        if (application.status === finalStatus) {
          return reply.code(200).send({ data: { accepted: true, duplicate: true, applicationId: application.id, status: application.status }, requestId: request.id });
        }
        return reply.code(409).send({ error: { code: "COLOR_TOKEN_APPLICATION_FINAL", message: "The application already has a different final outcome." } });
      }

      if (
        application.status !== "processing"
        || application.claimed_by_principal_id !== actorId
        || !application.lease_active
        || !matchesRewardLeaseToken(application.lease_token, body.data.leaseToken)
      ) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: { code: "COLOR_TOKEN_LEASE_INVALID", message: "This service does not hold the active lease for the color-token application." } });
      }

      if (body.data.outcome === "applied") {
        await client.query(
          `UPDATE operations.atlas_color_token_applications
              SET status = 'applied',
                  applied_at = clock_timestamp(),
                  claimed_by_principal_id = NULL,
                  lease_expires_at = NULL,
                  lease_token = NULL,
                  error_code = NULL,
                  updated_at = clock_timestamp()
            WHERE id = $1`,
          [application.id]
        );
      } else {
        await client.query(
          `UPDATE operations.atlas_color_token_applications
              SET status = 'failed',
                  error_code = $2,
                  claimed_by_principal_id = NULL,
                  lease_expires_at = NULL,
                  lease_token = NULL,
                  updated_at = clock_timestamp()
            WHERE id = $1`,
          [application.id, body.data.errorCode]
        );
      }

      await client.query(
        `INSERT INTO operations.audit_logs
          (actor_principal_id, action, resource_type, resource_id, outcome, metadata)
         VALUES ($1, $2, 'atlas_color_token_application', $3, 'success', $4::jsonb)`,
        [
          actorId,
          body.data.outcome === "applied"
            ? "atlas.color_token.application.applied"
            : "atlas.color_token.application.failed",
          application.id,
          JSON.stringify({
            entitlementId: application.entitlement_id,
            tokenKind: application.token_kind,
            assetId: application.asset_id,
            selectedColor: application.selected_color,
            outcome: body.data.outcome,
            errorCode: body.data.errorCode ?? null
          })
        ]
      );

      await client.query("COMMIT");
      return reply.code(202).send({
        data: { accepted: true, duplicate: false, applicationId: application.id, status: body.data.outcome },
        requestId: request.id
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      request.log.error({ err: error }, "ATLAS color-token application acknowledgement failed");
      return reply.code(500).send({ error: { code: "COLOR_TOKEN_ACK_FAILED", message: "The color-token application outcome could not be saved." } });
    } finally {
      client.release();
    }
  });
}
