import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requirePrincipal } from "../auth/session.js";
import { pool } from "../db.js";

const scopeSchema = z.object({
  clusterId: z.string().uuid().transform((value) => value.toLowerCase()),
  gridId: z.string().trim().min(1).max(200),
  serverId: z.string().uuid().transform((value) => value.toLowerCase())
}).strict();

const claimSchema = z.object({
  assetKind: z.enum(["tame", "ship"]),
  assetId: z.string().trim().min(1).max(256),
  lossEventId: z.string().trim().min(1).max(200),
  scope: scopeSchema
}).strict();

const claimListSchema = z.object({
  status: z.enum(["submitted", "approved", "denied"]).default("submitted"),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

const decisionSchema = z.object({
  decision: z.enum(["approve", "deny"]),
  note: z.string().trim().max(1000).optional()
}).strict();

async function requireInsuranceReviewer(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<string | null> {
  if (!pool) {
    await reply.code(503).send({ error: { code: "DATABASE_UNAVAILABLE", message: "Insurance claim review is temporarily unavailable." } });
    return null;
  }

  const principalId = await requirePrincipal(request, reply);
  if (!principalId) return null;

  const permission = await pool.query(
    `SELECT 1
       FROM core.principal_role_assignments pra
       JOIN core.role_permissions rp ON rp.role_id = pra.role_id
       JOIN core.permissions p ON p.id = rp.permission_id
      WHERE pra.principal_id = $1
        AND p.permission_key = 'atlas.insurance.claims.review'
        AND pra.scope_type = 'platform'
        AND pra.scope_id IS NULL
        AND (pra.expires_at IS NULL OR pra.expires_at > NOW())
      LIMIT 1`,
    [principalId]
  );

  if (!permission.rowCount) {
    await pool.query(
      `INSERT INTO operations.audit_logs
        (actor_principal_id, action, resource_type, outcome, metadata)
       VALUES ($1, 'atlas.insurance.claim.review.denied', 'atlas_insurance_claim', 'denied', $2::jsonb)`,
      [principalId, JSON.stringify({ requestId: request.id })]
    );
    await reply.code(403).send({ error: { code: "FORBIDDEN", message: "Platform ATLAS insurance review permission is required." } });
    return null;
  }

  return principalId;
}

function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string
) {
  return reply.code(status).send({ error: { code, message } });
}

export async function registerAtlasInsuranceRoutes(app: FastifyInstance): Promise<void> {
  app.post("/account/atlas/insurance/claims", async (request, reply) => {
    if (!pool) return sendError(reply, 503, "DATABASE_UNAVAILABLE", "Insurance claims are temporarily unavailable.");
    const principalId = await requirePrincipal(request, reply);
    if (!principalId) return;

    const parsed = claimSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "VALIDATION_ERROR", "A valid tame or ship loss event and exact ATLAS scope are required.");
    }

    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      return sendError(reply, 400, "IDEMPOTENCY_KEY_REQUIRED", "Provide an Idempotency-Key header between 8 and 128 characters.");
    }

    const requestHash = createHash("sha256")
      .update(JSON.stringify(parsed.data))
      .digest("hex");
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const existing = await client.query<{
        id: string;
        request_hash: string;
        status: string;
        snapshot_id: string;
        loss_event_external_id: string;
      }>(
        `SELECT id, request_hash, status, snapshot_id, loss_event_external_id
           FROM operations.atlas_insurance_claims
          WHERE principal_id = $1 AND idempotency_key = $2
          FOR UPDATE`,
        [principalId, idempotencyKey]
      );

      if (existing.rows[0]) {
        await client.query("ROLLBACK");
        if (existing.rows[0].request_hash !== requestHash) {
          return sendError(reply, 409, "IDEMPOTENCY_CONFLICT", "This idempotency key was already used for a different insurance claim.");
        }
        return reply.code(200).send({
          data: {
            claimId: existing.rows[0].id,
            status: existing.rows[0].status,
            snapshotId: existing.rows[0].snapshot_id,
            lossEventId: existing.rows[0].loss_event_external_id,
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
        return sendError(reply, 409, "VERIFIED_STEAM_ACCOUNT_REQUIRED", "Link and verify a Steam account before submitting an ATLAS insurance claim.");
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
        return sendError(reply, 409, "INSURANCE_SCOPE_MISMATCH", "The server, cluster, and ATLAS grid do not match Core's registered topology.");
      }

      const expectedEventType = parsed.data.assetKind === "tame" ? "tame.died" : "ship.sunk";
      const lossEvent = await client.query<{
        id: string;
        occurred_at: Date;
        payload: Record<string, unknown>;
      }>(
        `SELECT id, occurred_at, payload
           FROM operations.game_events
          WHERE server_id = $1
            AND cluster_id = $2
            AND grid_id = $3
            AND external_event_id = $4
            AND event_type = $5
          FOR SHARE`,
        [
          parsed.data.scope.serverId,
          parsed.data.scope.clusterId,
          parsed.data.scope.gridId,
          parsed.data.lossEventId,
          expectedEventType
        ]
      );
      const event = lossEvent.rows[0];
      if (!event) {
        await client.query("ROLLBACK");
        return sendError(reply, 409, "VERIFIED_LOSS_EVENT_REQUIRED", "A matching server-recorded tame death or ship sinking event is required.");
      }
      if (event.occurred_at.getTime() > Date.now() + 5 * 60 * 1000) {
        await client.query("ROLLBACK");
        return sendError(reply, 409, "LOSS_EVENT_TIME_INVALID", "The recorded loss event timestamp is too far in the future.");
      }
      if (event.payload.assetId !== parsed.data.assetId || event.payload.ownerId !== steamId) {
        await client.query("ROLLBACK");
        return sendError(reply, 409, "LOSS_EVENT_OWNERSHIP_MISMATCH", "The recorded loss event does not match the requested asset and verified Steam owner.");
      }

      const snapshot = await client.query<{ id: string }>(
        `SELECT snapshot_id AS id
           FROM operations.asset_snapshots
          WHERE server_id = $1
            AND cluster_id = $2
            AND grid_id = $3
            AND kind = $4
            AND asset_id = $5
            AND owner_id = $6
            AND captured_at < $7
          ORDER BY captured_at DESC
          LIMIT 1
          FOR SHARE`,
        [
          parsed.data.scope.serverId,
          parsed.data.scope.clusterId,
          parsed.data.scope.gridId,
          parsed.data.assetKind,
          parsed.data.assetId,
          steamId,
          event.occurred_at
        ]
      );
      const snapshotId = snapshot.rows[0]?.id;
      if (!snapshotId) {
        await client.query("ROLLBACK");
        return sendError(reply, 409, "PRE_LOSS_SNAPSHOT_REQUIRED", "No eligible pre-loss snapshot exists for this asset, owner, and exact server scope.");
      }

      const entitlementResult = await client.query<{
        id: string;
        quantity: number;
        claims_used: number;
      }>(
        `SELECT e.id, e.quantity,
                (SELECT COUNT(*)::integer
                   FROM operations.atlas_insurance_claims c
                  WHERE c.entitlement_id = e.id
                    AND c.status IN ('submitted', 'approved')) AS claims_used
           FROM commerce.entitlements e
           JOIN commerce.atlas_insurance_products ip ON ip.product_id = e.product_id
           JOIN commerce.order_items oi ON oi.id = e.order_item_id
           JOIN commerce.orders o ON o.id = oi.order_id AND o.principal_id = e.principal_id
          WHERE e.principal_id = $1
            AND ip.asset_kind = $2
            AND e.status = 'active'
            AND e.revoked_at IS NULL
            AND o.status = 'paid'
            AND EXISTS (
              SELECT 1
                FROM commerce.payment_transactions pt
               WHERE pt.order_id = o.id
                 AND pt.status = 'succeeded'
                 AND pt.verified_at IS NOT NULL
                 AND pt.verified_at <= $3
            )
            AND (e.expires_at IS NULL OR e.expires_at > NOW())
            AND e.granted_at <= $3
            AND e.granted_at + (ip.coverage_seconds * INTERVAL '1 second') >= $3
            AND (e.expires_at IS NULL OR e.expires_at >= $3)
          ORDER BY e.granted_at DESC
          FOR UPDATE OF e`,
        [principalId, parsed.data.assetKind, event.occurred_at]
      );
      const eligibleEntitlements = entitlementResult.rows;
      const entitlement = eligibleEntitlements.find((candidate) => candidate.claims_used < candidate.quantity);
      if (!entitlement) {
        await client.query("ROLLBACK");
        if (eligibleEntitlements.length) {
          return sendError(reply, 409, "INSURANCE_CLAIM_LIMIT_REACHED", "All claim uses included in the matching insurance entitlements have already been submitted or approved.");
        }
        return sendError(reply, 409, "ACTIVE_INSURANCE_REQUIRED", "No active, payment-verified insurance entitlement covers this asset type and loss time.");
      }

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO operations.atlas_insurance_claims
          (principal_id, entitlement_id, asset_kind, asset_id, owner_external_id,
           server_id, cluster_id, grid_id, loss_event_record_id, loss_event_external_id,
           loss_occurred_at, snapshot_id, idempotency_key, request_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING id`,
        [
          principalId,
          entitlement.id,
          parsed.data.assetKind,
          parsed.data.assetId,
          steamId,
          parsed.data.scope.serverId,
          parsed.data.scope.clusterId,
          parsed.data.scope.gridId,
          event.id,
          parsed.data.lossEventId,
          event.occurred_at,
          snapshotId,
          idempotencyKey,
          requestHash
        ]
      );
      const claimId = inserted.rows[0]?.id;
      if (!claimId) throw new Error("Insurance claim insert returned no identifier.");

      await client.query(
        `INSERT INTO operations.audit_logs
          (actor_principal_id, action, resource_type, resource_id, outcome, metadata)
         VALUES ($1, 'atlas.insurance.claim.submitted', 'atlas_insurance_claim', $2, 'success', $3::jsonb)`,
        [principalId, claimId, JSON.stringify({
          assetKind: parsed.data.assetKind,
          assetId: parsed.data.assetId,
          serverId: parsed.data.scope.serverId,
          clusterId: parsed.data.scope.clusterId,
          gridId: parsed.data.scope.gridId,
          lossEventId: parsed.data.lossEventId,
          snapshotId
        })]
      );

      await client.query("COMMIT");
      return reply.code(201).send({
        data: { claimId, status: "submitted", snapshotId, lossEventId: parsed.data.lossEventId, duplicate: false },
        requestId: request.id
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
        return sendError(reply, 409, "INSURANCE_CLAIM_CONFLICT", "This loss event has already been submitted as an insurance claim.");
      }
      request.log.error({ err: error }, "ATLAS insurance claim submission failed");
      return sendError(reply, 500, "INSURANCE_CLAIM_FAILED", "The insurance claim could not be submitted.");
    } finally {
      client.release();
    }
  });

  app.get("/admin/atlas/insurance/claims", async (request, reply) => {
    if (!pool) return sendError(reply, 503, "DATABASE_UNAVAILABLE", "Insurance claim review is temporarily unavailable.");
    const actorId = await requireInsuranceReviewer(request, reply);
    if (!actorId) return;

    const parsed = claimListSchema.safeParse(request.query);
    if (!parsed.success) return sendError(reply, 400, "VALIDATION_ERROR", "The claim status or result limit is invalid.");

    const result = await pool.query(
      `SELECT c.id AS "claimId", c.principal_id AS "principalId",
              c.entitlement_id AS "entitlementId", c.asset_kind AS "assetKind",
              c.asset_id AS "assetId", c.owner_external_id AS "ownerSteamId",
              c.server_id AS "serverId", c.cluster_id AS "clusterId",
              c.grid_id AS "gridId", c.loss_event_external_id AS "lossEventId",
              c.loss_occurred_at AS "lossOccurredAt", c.snapshot_id AS "snapshotId",
              c.status, c.reviewed_by AS "reviewedBy", c.reviewed_at AS "reviewedAt",
              c.decision_note AS "decisionNote", c.created_at AS "createdAt"
         FROM operations.atlas_insurance_claims c
        WHERE c.status = $1
        ORDER BY c.created_at ASC
        LIMIT $2`,
      [parsed.data.status, parsed.data.limit]
    );
    return { data: result.rows, requestId: request.id };
  });

  app.post("/admin/atlas/insurance/claims/:claimId/decision", async (request, reply) => {
    if (!pool) return sendError(reply, 503, "DATABASE_UNAVAILABLE", "Insurance claim review is temporarily unavailable.");
    const actorId = await requireInsuranceReviewer(request, reply);
    if (!actorId) return;

    const params = z.object({ claimId: z.string().uuid() }).safeParse(request.params);
    const parsed = decisionSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return sendError(reply, 400, "VALIDATION_ERROR", "A valid claim ID and review decision are required.");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<{
        id: string;
        status: string;
        principal_id: string;
        entitlement_id: string;
        asset_kind: string;
        asset_id: string;
        owner_external_id: string;
        server_id: string;
        cluster_id: string;
        grid_id: string;
        loss_event_external_id: string;
        loss_occurred_at: Date;
        snapshot_id: string;
      }>(
        `SELECT id, status, principal_id, entitlement_id, asset_kind, asset_id,
                owner_external_id, server_id, cluster_id, grid_id,
                loss_event_external_id, loss_occurred_at, snapshot_id
           FROM operations.atlas_insurance_claims
          WHERE id = $1
          FOR UPDATE`,
        [params.data.claimId]
      );
      const claim = current.rows[0];
      if (!claim) {
        await client.query("ROLLBACK");
        return sendError(reply, 404, "INSURANCE_CLAIM_NOT_FOUND", "The insurance claim was not found.");
      }

      const nextStatus = parsed.data.decision === "approve" ? "approved" : "denied";
      if (claim.status !== "submitted") {
        await client.query("ROLLBACK");
        if (claim.status === nextStatus) {
          return reply.code(200).send({ data: { claimId: claim.id, status: claim.status, duplicate: true }, requestId: request.id });
        }
        return sendError(reply, 409, "INSURANCE_CLAIM_ALREADY_REVIEWED", "This claim has already received a different review decision.");
      }

      await client.query(
        `UPDATE operations.atlas_insurance_claims
            SET status = $2, reviewed_by = $3, reviewed_at = NOW(),
                decision_note = $4, updated_at = NOW()
          WHERE id = $1`,
        [claim.id, nextStatus, actorId, parsed.data.note ?? null]
      );

      if (nextStatus === "approved") {
        await client.query(
          `INSERT INTO operations.event_outbox
            (event_type, aggregate_type, aggregate_id, payload)
           VALUES ('atlas.insurance.recovery.authorized', 'atlas_insurance_claim', $1, $2::jsonb)`,
          [claim.id, JSON.stringify({
            claimId: claim.id,
            principalId: claim.principal_id,
            entitlementId: claim.entitlement_id,
            assetKind: claim.asset_kind,
            assetId: claim.asset_id,
            ownerSteamId: claim.owner_external_id,
            serverId: claim.server_id,
            clusterId: claim.cluster_id,
            gridId: claim.grid_id,
            lossEventId: claim.loss_event_external_id,
            lossOccurredAt: claim.loss_occurred_at,
            snapshotId: claim.snapshot_id,
            authorizedBy: actorId
          })]
        );
      }

      await client.query(
        `INSERT INTO operations.audit_logs
          (actor_principal_id, action, resource_type, resource_id, outcome, metadata)
         VALUES ($1, $2, 'atlas_insurance_claim', $3, 'success', $4::jsonb)`,
        [actorId, nextStatus === "approved" ? "atlas.insurance.claim.approved" : "atlas.insurance.claim.denied",
          claim.id, JSON.stringify({ note: parsed.data.note ?? null })]
      );

      await client.query("COMMIT");
      return reply.code(202).send({ data: { claimId: claim.id, status: nextStatus, duplicate: false }, requestId: request.id });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      request.log.error({ err: error }, "ATLAS insurance claim review failed");
      return sendError(reply, 500, "INSURANCE_CLAIM_REVIEW_FAILED", "The insurance claim decision could not be saved.");
    } finally {
      client.release();
    }
  });
}
