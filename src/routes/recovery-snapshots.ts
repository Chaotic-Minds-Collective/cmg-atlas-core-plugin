import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireServicePermission } from "../auth/service.js";
import { pool } from "../db.js";

const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_STATE_BYTES + 64 * 1024;

const scopeSchema = z.object({
  clusterId: z.string().uuid().transform((value) => value.toLowerCase()),
  gridId: z.string().min(1).max(200),
  serverId: z.string().uuid().transform((value) => value.toLowerCase())
}).strict();

const snapshotSchema = z.object({
  snapshotId: z.string().min(1).max(200),
  kind: z.enum(["inventory", "tame", "ship"]),
  assetId: z.string().min(1).max(256),
  ownerId: z.string().min(1).max(256),
  scope: scopeSchema,
  capturedAt: z.string().min(20).max(40).refine((value) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  ),
  state: z.record(z.string(), z.unknown()),
  reason: z.string().min(1).max(128).default("scheduled")
}).strict();

const listSchema = z.object({
  kind: z.enum(["inventory", "tame", "ship"]).optional(),
  assetId: z.string().min(1).max(256).optional(),
  ownerId: z.string().min(1).max(256).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25)
});

function errorResponse(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message } });
}

export async function registerRecoverySnapshotRoutes(app: FastifyInstance): Promise<void> {
  app.post("/integrations/servers/:serverId/recovery/snapshots", {
    bodyLimit: MAX_REQUEST_BYTES
  }, async (request, reply) => {
    if (!pool) return errorResponse(reply, 503, "DATABASE_UNAVAILABLE", "Recovery snapshot storage is temporarily unavailable.");
    const params = z.object({ serverId: z.string().uuid().transform((value) => value.toLowerCase()) }).safeParse(request.params);
    const body = snapshotSchema.safeParse(request.body);
    if (!params.success || !body.success || body.data.scope.serverId !== params.data?.serverId) {
      return errorResponse(reply, 400, "VALIDATION_ERROR", "A valid snapshot and matching server scope are required.");
    }

    const stateJson = JSON.stringify(body.data.state);
    const stateBytes = Buffer.byteLength(stateJson, "utf8");
    if (stateBytes < 1 || stateBytes > MAX_STATE_BYTES) {
      return errorResponse(reply, 413, "SNAPSHOT_TOO_LARGE", "Snapshot state must not exceed 16 MiB.");
    }

    const actorId = await requireServicePermission(request, reply, "recovery.snapshots.write", "server", params.data.serverId);
    if (!actorId) return;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const scope = await client.query(
        `SELECT s.id
           FROM core.servers s
           JOIN games_atlas.maps m
             ON m.server_id = s.id AND m.cluster_id = s.cluster_id
          WHERE s.id = $1 AND s.cluster_id = $2
            AND s.game_key = 'atlas' AND m.map_key = $3`,
        [params.data.serverId, body.data.scope.clusterId, body.data.scope.gridId]
      );
      if (scope.rows.length !== 1) {
        await client.query("ROLLBACK");
        return errorResponse(reply, 409, "SNAPSHOT_SCOPE_MISMATCH", "The server, cluster, and ATLAS grid do not match Core's registered topology.");
      }

      const values = [
        params.data.serverId,
        body.data.scope.clusterId,
        body.data.scope.gridId,
        body.data.snapshotId,
        body.data.kind,
        body.data.assetId,
        body.data.ownerId,
        body.data.capturedAt,
        stateJson,
        stateBytes,
        body.data.reason
      ];
      const inserted = await client.query(
        `INSERT INTO operations.atlas_recovery_snapshots
          (server_id, cluster_id, grid_id, snapshot_id, snapshot_kind, asset_id,
           owner_id, captured_at, state, state_bytes, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
         ON CONFLICT (server_id, snapshot_id) DO NOTHING
         RETURNING id, snapshot_id`,
        values
      );

      let receiptId: string;
      let duplicate = false;
      if (inserted.rows[0]) {
        receiptId = inserted.rows[0].id;
      } else {
        const existing = await client.query(
          `SELECT id,
                  (cluster_id = $2 AND grid_id = $3 AND snapshot_kind = $5
                   AND asset_id = $6 AND owner_id = $7 AND captured_at = $8
                   AND state = $9::jsonb AND state_bytes = $10 AND reason = $11) AS matches
             FROM operations.atlas_recovery_snapshots
            WHERE server_id = $1 AND snapshot_id = $4
            FOR UPDATE`,
          values
        );
        if (!existing.rows[0] || !existing.rows[0].matches) {
          await client.query("ROLLBACK");
          return errorResponse(reply, 409, "SNAPSHOT_ID_CONFLICT", "This snapshot ID already exists with different content.");
        }
        receiptId = existing.rows[0].id;
        duplicate = true;
      }

      await client.query(
        `INSERT INTO operations.audit_logs
          (actor_principal_id, action, resource_type, resource_id, outcome, metadata)
         VALUES ($1, 'recovery.snapshot.persist', 'atlas_recovery_snapshot', $2, 'success', $3::jsonb)`,
        [actorId, receiptId, JSON.stringify({ serverId: params.data.serverId, kind: body.data.kind, duplicate })]
      );
      await client.query("COMMIT");
      return reply.code(duplicate ? 200 : 201).send({
        data: { snapshotId: body.data.snapshotId, durable: true, receipt: receiptId, duplicate },
        requestId: request.id
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      request.log.error({ err: error }, "Recovery snapshot persistence failed");
      return errorResponse(reply, 500, "SNAPSHOT_PERSIST_FAILED", "The recovery snapshot could not be persisted.");
    } finally {
      client.release();
    }
  });

  app.get("/integrations/servers/:serverId/recovery/snapshots", async (request, reply) => {
    if (!pool) return errorResponse(reply, 503, "DATABASE_UNAVAILABLE", "Recovery snapshot storage is temporarily unavailable.");
    const params = z.object({ serverId: z.string().uuid().transform((value) => value.toLowerCase()) }).safeParse(request.params);
    const query = listSchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return errorResponse(reply, 400, "VALIDATION_ERROR", "Valid snapshot search filters are required.");
    }
    const actorId = await requireServicePermission(request, reply, "recovery.snapshots.read", "server", params.data.serverId);
    if (!actorId) return;

    try {
      const result = await pool.query(
        `SELECT snapshot_id AS "snapshotId", snapshot_kind AS kind, asset_id AS "assetId",
                owner_id AS "ownerId", grid_id AS "gridId", captured_at AS "capturedAt",
                state_bytes AS "stateBytes", reason
           FROM operations.atlas_recovery_snapshots
          WHERE server_id = $1
            AND ($2::text IS NULL OR snapshot_kind = $2)
            AND ($3::text IS NULL OR asset_id = $3)
            AND ($4::text IS NULL OR owner_id = $4)
          ORDER BY captured_at DESC, id DESC
          LIMIT $5`,
        [params.data.serverId, query.data.kind ?? null, query.data.assetId ?? null, query.data.ownerId ?? null, query.data.limit]
      );
      await pool.query(
        `INSERT INTO operations.audit_logs
          (actor_principal_id, action, resource_type, resource_id, outcome, metadata)
         VALUES ($1, 'recovery.snapshot.list', 'server', $2, 'success', $3::jsonb)`,
        [actorId, params.data.serverId, JSON.stringify({ resultCount: result.rows.length, filters: query.data })]
      );
      return { data: result.rows, requestId: request.id };
    } catch (error) {
      request.log.error({ err: error }, "Recovery snapshot listing failed");
      return errorResponse(reply, 500, "SNAPSHOT_LIST_FAILED", "Recovery snapshots could not be listed.");
    }
  });

  app.get("/integrations/servers/:serverId/recovery/snapshots/:snapshotId", async (request, reply) => {
    if (!pool) return errorResponse(reply, 503, "DATABASE_UNAVAILABLE", "Recovery snapshot storage is temporarily unavailable.");
    const params = z.object({
      serverId: z.string().uuid().transform((value) => value.toLowerCase()),
      snapshotId: z.string().min(1).max(200)
    }).safeParse(request.params);
    if (!params.success) return errorResponse(reply, 400, "VALIDATION_ERROR", "A valid server UUID and snapshot ID are required.");
    const actorId = await requireServicePermission(request, reply, "recovery.snapshots.read", "server", params.data.serverId);
    if (!actorId) return;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `SELECT snapshot_id AS "snapshotId", snapshot_kind AS kind, asset_id AS "assetId",
                owner_id AS "ownerId", cluster_id AS "clusterId", grid_id AS "gridId",
                server_id AS "serverId", captured_at AS "capturedAt", state, state_bytes AS "stateBytes", reason
           FROM operations.atlas_recovery_snapshots
          WHERE server_id = $1 AND snapshot_id = $2`,
        [params.data.serverId, params.data.snapshotId]
      );
      if (!result.rows[0]) {
        await client.query("ROLLBACK");
        return errorResponse(reply, 404, "SNAPSHOT_NOT_FOUND", "The recovery snapshot was not found for this server.");
      }
      await client.query(
        `INSERT INTO operations.audit_logs
          (actor_principal_id, action, resource_type, resource_id, outcome)
         VALUES ($1, 'recovery.snapshot.read', 'atlas_recovery_snapshot', $2, 'success')`,
        [actorId, params.data.snapshotId]
      );
      await client.query("COMMIT");
      return { data: result.rows[0], requestId: request.id };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      request.log.error({ err: error }, "Recovery snapshot read failed");
      return errorResponse(reply, 500, "SNAPSHOT_READ_FAILED", "The recovery snapshot could not be read.");
    } finally {
      client.release();
    }
  });
}
