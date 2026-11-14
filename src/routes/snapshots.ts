import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireServicePermission } from "../auth/service.js";
import { pool } from "../db.js";

const MAX_STATE_BYTES = 1_048_576;
const MAX_CIPHERTEXT_BYTES = 1_398_104;
const base64Schema = z.string().min(1).max(MAX_CIPHERTEXT_BYTES).refine((value) => {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  return Buffer.from(value, "base64").toString("base64") === value;
}, "must be canonical base64");

const snapshotSchema = z.object({
  snapshotId: z.string().uuid(),
  clusterId: z.string().uuid(),
  gridId: z.string().min(1).max(200),
  kind: z.enum(["inventory", "tame", "ship"]),
  assetId: z.string().min(1).max(200),
  ownerId: z.string().min(1).max(200),
  capturedAt: z.string().datetime({ offset: true }),
  reason: z.enum(["scheduled", "pre-loss", "manual", "reconciliation"]),
  schemaVersion: z.literal(1),
  stateBytes: z.number().int().min(1).max(MAX_STATE_BYTES),
  encryption: z.object({
    algorithm: z.literal("AES-256-GCM"),
    keyId: z.string().min(1).max(200),
    nonce: z.string().regex(/^[A-Za-z0-9+/]{16}$/),
    authTag: z.string().regex(/^[A-Za-z0-9+/]{22}==$/),
    ciphertext: base64Schema
  }).strict()
}).strict().refine((value) => Buffer.from(value.encryption.ciphertext, "base64").byteLength <= MAX_CIPHERTEXT_BYTES);

const listSchema = z.object({
  kind: z.enum(["inventory", "tame", "ship"]),
  assetId: z.string().min(1).max(200),
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25)
}).strict().refine((value) => value.before === undefined || Number.isFinite(Date.parse(value.before)));

export async function registerSnapshotRoutes(app: FastifyInstance): Promise<void> {
  app.post("/integrations/servers/:serverId/snapshots", { bodyLimit: 2 * 1024 * 1024 }, async (request, reply) => {
    if (!pool) return reply.code(503).send({ error: { code: "DATABASE_UNAVAILABLE", message: "Snapshot storage is temporarily unavailable." } });
    const params = z.object({ serverId: z.string().uuid() }).safeParse(request.params);
    const body = snapshotSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "A valid server ID and encrypted snapshot envelope are required." } });

    const actorId = await requireServicePermission(request, reply, "snapshots.write", "server", params.data.serverId);
    if (!actorId) return;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const server = await client.query("SELECT cluster_id, game_key FROM core.servers WHERE id = $1 AND status <> 'deleted'", [params.data.serverId]);
      const record = server.rows[0];
      if (!record || record.game_key !== "atlas") {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: { code: "ATLAS_SERVER_NOT_FOUND", message: "The assigned ATLAS server was not found." } });
      }
      if (record.cluster_id !== body.data.clusterId) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: { code: "SNAPSHOT_SCOPE_MISMATCH", message: "The snapshot cluster does not match the assigned server." } });
      }

      const encrypted = body.data.encryption;
      const ciphertext = Buffer.from(encrypted.ciphertext, "base64");
      const inserted = await client.query(
        "INSERT INTO operations.asset_snapshots (snapshot_id, server_id, cluster_id, grid_id, kind, asset_id, owner_id, captured_at, reason, schema_version, encryption_algorithm, encryption_key_id, nonce, auth_tag, ciphertext, ciphertext_bytes, state_bytes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT (snapshot_id) DO NOTHING RETURNING snapshot_id",
        [body.data.snapshotId, params.data.serverId, body.data.clusterId, body.data.gridId, body.data.kind, body.data.assetId, body.data.ownerId, body.data.capturedAt, body.data.reason, body.data.schemaVersion, encrypted.algorithm, encrypted.keyId, Buffer.from(encrypted.nonce, "base64"), Buffer.from(encrypted.authTag, "base64"), ciphertext, ciphertext.byteLength, body.data.stateBytes]
      );

      if (inserted.rows.length === 0) {
        const existing = await client.query(
          "SELECT server_id, cluster_id, grid_id, kind, asset_id, owner_id, captured_at, reason, schema_version, encryption_algorithm, encryption_key_id, nonce, auth_tag, ciphertext, state_bytes FROM operations.asset_snapshots WHERE snapshot_id = $1 FOR UPDATE",
          [body.data.snapshotId]
        );
        const prior = existing.rows[0];
        const same = prior &&
          prior.server_id === params.data.serverId &&
          prior.cluster_id === body.data.clusterId &&
          prior.grid_id === body.data.gridId &&
          prior.kind === body.data.kind &&
          prior.asset_id === body.data.assetId &&
          prior.owner_id === body.data.ownerId &&
          new Date(prior.captured_at).getTime() === Date.parse(body.data.capturedAt) &&
          prior.reason === body.data.reason &&
          prior.schema_version === body.data.schemaVersion &&
          prior.encryption_algorithm === encrypted.algorithm &&
          prior.encryption_key_id === encrypted.keyId &&
          Buffer.from(prior.nonce).equals(Buffer.from(encrypted.nonce, "base64")) &&
          Buffer.from(prior.auth_tag).equals(Buffer.from(encrypted.authTag, "base64")) &&
          Buffer.from(prior.ciphertext).equals(ciphertext) &&
          prior.state_bytes === body.data.stateBytes;
        if (!same) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: { code: "SNAPSHOT_ID_CONFLICT", message: "The snapshot ID already exists with different content or scope." } });
        }
      }

      await client.query(
        "INSERT INTO operations.audit_logs (actor_principal_id, action, resource_type, resource_id, outcome, metadata) VALUES ($1, 'asset_snapshot.persist', 'asset_snapshot', $2, 'success', $3::jsonb)",
        [actorId, body.data.snapshotId, JSON.stringify({ serverId: params.data.serverId, kind: body.data.kind, assetId: body.data.assetId, gridId: body.data.gridId, ciphertextBytes: ciphertext.byteLength })]
      );
      await client.query("COMMIT");
      return reply.code(inserted.rows.length === 0 ? 200 : 201).send({
        data: { snapshotId: body.data.snapshotId, durable: true, duplicate: inserted.rows.length === 0, receipt: body.data.snapshotId },
        requestId: request.id
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      request.log.error({ err: error }, "Encrypted snapshot persistence failed");
      return reply.code(500).send({ error: { code: "SNAPSHOT_PERSIST_FAILED", message: "The encrypted snapshot could not be stored." } });
    } finally {
      client.release();
    }
  });

  app.get("/integrations/servers/:serverId/snapshots", async (request, reply) => {
    if (!pool) return reply.code(503).send({ error: { code: "DATABASE_UNAVAILABLE", message: "Snapshot storage is temporarily unavailable." } });
    const params = z.object({ serverId: z.string().uuid() }).safeParse(request.params);
    const query = listSchema.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "A valid server ID and snapshot lookup are required." } });
    const actorId = await requireServicePermission(request, reply, "snapshots.read", "server", params.data.serverId);
    if (!actorId) return;

    const result = await pool.query(
      "SELECT snapshot_id AS \"snapshotId\", kind, asset_id AS \"assetId\", owner_id AS \"ownerId\", cluster_id AS \"clusterId\", grid_id AS \"gridId\", captured_at AS \"capturedAt\", reason, schema_version AS \"schemaVersion\", state_bytes AS \"stateBytes\", encryption_algorithm AS \"encryptionAlgorithm\", encryption_key_id AS \"keyId\", created_at AS \"createdAt\" FROM operations.asset_snapshots WHERE server_id = $1 AND kind = $2 AND asset_id = $3 AND ($4::timestamptz IS NULL OR captured_at < $4::timestamptz) ORDER BY captured_at DESC, snapshot_id DESC LIMIT $5",
      [params.data.serverId, query.data.kind, query.data.assetId, query.data.before ?? null, query.data.limit]
    );
    return { data: result.rows, requestId: request.id };
  });

  app.get("/integrations/servers/:serverId/snapshots/:snapshotId", async (request, reply) => {
    if (!pool) return reply.code(503).send({ error: { code: "DATABASE_UNAVAILABLE", message: "Snapshot storage is temporarily unavailable." } });
    const params = z.object({ serverId: z.string().uuid(), snapshotId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Valid server and snapshot UUIDs are required." } });
    const actorId = await requireServicePermission(request, reply, "snapshots.read", "server", params.data.serverId);
    if (!actorId) return;

    const result = await pool.query(
      "SELECT snapshot_id AS \"snapshotId\", kind, asset_id AS \"assetId\", owner_id AS \"ownerId\", cluster_id AS \"clusterId\", grid_id AS \"gridId\", captured_at AS \"capturedAt\", reason, schema_version AS \"schemaVersion\", state_bytes AS \"stateBytes\", encryption_algorithm AS \"algorithm\", encryption_key_id AS \"keyId\", encode(nonce, 'base64') AS nonce, encode(auth_tag, 'base64') AS \"authTag\", encode(ciphertext, 'base64') AS ciphertext, created_at AS \"createdAt\" FROM operations.asset_snapshots WHERE server_id = $1 AND snapshot_id = $2",
      [params.data.serverId, params.data.snapshotId]
    );
    const snapshot = result.rows[0];
    if (!snapshot) return reply.code(404).send({ error: { code: "SNAPSHOT_NOT_FOUND", message: "The snapshot was not found for this server." } });

    await pool.query(
      "INSERT INTO operations.audit_logs (actor_principal_id, action, resource_type, resource_id, outcome, metadata) VALUES ($1, 'asset_snapshot.read', 'asset_snapshot', $2, 'success', $3::jsonb)",
      [actorId, params.data.snapshotId, JSON.stringify({ serverId: params.data.serverId })]
    );
    return { data: snapshot, requestId: request.id };
  });
}
