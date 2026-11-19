import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { requireServicePermission } from "../auth/service.js";
import { pool } from "../db.js";

const uuid = z.string().uuid().transform((value) => value.toLowerCase());
const objectiveSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  eventType: z.enum(["player.joined", "player.left"]),
  targetCount: z.number().int().min(1).max(100000),
  description: z.string().trim().min(1).max(300).optional()
}).strict();
const definitionSchema = z.object({
  schemaVersion: z.literal(1),
  questId: uuid,
  revision: z.number().int().min(1),
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean(),
  scope: z.object({
    clusterId: uuid,
    gridIds: z.array(z.string().trim().min(1).max(200)).min(1).max(100).optional(),
    serverIds: z.array(uuid).min(1).max(100).optional()
  }).strict(),
  objectives: z.array(objectiveSchema).min(1).max(20)
}).strict().superRefine((value, context) => {
  const ids = value.objectives.map((objective) => objective.id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", path: ["objectives"], message: "Objective IDs must be unique." });
  for (const [field, values] of [["gridIds", value.scope.gridIds], ["serverIds", value.scope.serverIds]] as const) {
    if (values && new Set(values).size !== values.length) context.addIssue({ code: "custom", path: ["scope", field], message: `${field} must not contain duplicates.` });
  }
});
const playerProgressSchema = z.object({
  objectives: z.record(z.string(), z.number().int().min(0).max(100000)),
  completed: z.boolean(),
  completedAt: z.string().datetime({ offset: true }).nullable()
}).strict();
const progressStateSchema = z.object({
  schemaVersion: z.literal(1),
  questId: uuid,
  questRevision: z.number().int().min(1),
  processedEventIds: z.array(uuid).max(1000),
  players: z.record(z.string().min(1).max(128), playerProgressSchema)
}).strict();

function sendError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message } });
}

async function getAtlasServerContext(client: { query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }> }, serverId: string) {
  const result = await client.query(
    `SELECT s.id AS "serverId", s.cluster_id AS "clusterId", m.map_key AS "gridId"
       FROM core.servers s
       JOIN games_atlas.maps m ON m.server_id = s.id AND m.cluster_id = s.cluster_id
      WHERE s.id = $1 AND s.game_key = 'atlas' AND s.status <> 'deleted'`,
    [serverId]
  );
  return result.rows[0] as { serverId: string; clusterId: string; gridId: string } | undefined;
}

function questMatchesScope(definition: z.infer<typeof definitionSchema>, clusterId: string, gridId: string, serverId: string) {
  return definition.enabled && definition.scope.clusterId === clusterId &&
    (!definition.scope.gridIds || definition.scope.gridIds.includes(gridId)) &&
    (!definition.scope.serverIds || definition.scope.serverIds.includes(serverId));
}

export async function registerAtlasQuestRoutes(app: FastifyInstance): Promise<void> {
  app.put("/integrations/clusters/:clusterId/quests/:questId", async (request, reply) => {
    if (!pool) return sendError(reply, 503, "DATABASE_UNAVAILABLE", "Quest storage is temporarily unavailable.");
    const params = z.object({ clusterId: uuid, questId: uuid }).safeParse(request.params);
    const body = z.object({ expectedRevision: z.number().int().min(0), definition: definitionSchema }).strict().safeParse(request.body);
    if (!params.success || !body.success || body.data.definition.questId !== params.data?.questId || body.data.definition.scope.clusterId !== params.data?.clusterId || body.data.definition.revision !== body.data.expectedRevision + 1) {
      return sendError(reply, 400, "VALIDATION_ERROR", "A valid versioned quest definition, matching IDs, and next expected revision are required.");
    }
    const actorId = await requireServicePermission(request, reply, "quests.manage", "cluster", params.data.clusterId);
    if (!actorId) return;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const cluster = await client.query("SELECT id FROM core.clusters WHERE id = $1 AND game_key = 'atlas' FOR UPDATE", [params.data.clusterId]);
      if (!cluster.rows[0]) {
        await client.query("ROLLBACK");
        return sendError(reply, 404, "ATLAS_CLUSTER_NOT_FOUND", "The ATLAS cluster was not found.");
      }
      const latest = await client.query<{ revision: number }>(
        `SELECT revision FROM games_atlas.quests WHERE cluster_id = $1 AND quest_id = $2 ORDER BY revision DESC LIMIT 1`,
        [params.data.clusterId, params.data.questId]
      );
      const currentRevision = latest.rows[0]?.revision ?? 0;
      if (currentRevision !== body.data.expectedRevision) {
        await client.query("ROLLBACK");
        return sendError(reply, 409, "QUEST_REVISION_CONFLICT", "The quest changed since it was loaded. Refresh and submit the next revision.");
      }
      const inserted = await client.query(
        `INSERT INTO games_atlas.quests (cluster_id, quest_id, revision, definition, created_by)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         RETURNING quest_id AS "questId", revision, definition, created_at AS "createdAt"`,
        [params.data.clusterId, params.data.questId, body.data.definition.revision, JSON.stringify(body.data.definition), actorId]
      );
      await client.query(
        `INSERT INTO operations.audit_logs (actor_principal_id, action, resource_type, resource_id, outcome, metadata)
         VALUES ($1, 'atlas.quest.publish', 'atlas_quest', $2, 'success', $3::jsonb)`,
        [actorId, params.data.questId, JSON.stringify({ clusterId: params.data.clusterId, revision: body.data.definition.revision, enabled: body.data.definition.enabled })]
      );
      await client.query("COMMIT");
      return reply.code(201).send({ data: inserted.rows[0], requestId: request.id });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      request.log.error({ err: error }, "ATLAS quest publication failed");
      return sendError(reply, 500, "QUEST_PUBLISH_FAILED", "The quest definition could not be saved.");
    } finally {
      client.release();
    }
  });

  app.get("/integrations/servers/:serverId/quests", async (request, reply) => {
    if (!pool) return sendError(reply, 503, "DATABASE_UNAVAILABLE", "Quest storage is temporarily unavailable.");
    const params = z.object({ serverId: uuid }).safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "INVALID_SERVER_ID", "A valid server UUID is required.");
    const actorId = await requireServicePermission(request, reply, "quests.read", "server", params.data.serverId);
    if (!actorId) return;
    try {
      const context = await getAtlasServerContext(pool, params.data.serverId);
      if (!context) return sendError(reply, 404, "ATLAS_SERVER_NOT_FOUND", "The ATLAS server or grid was not found.");
      const result = await pool.query(
        `SELECT DISTINCT ON (quest_id) quest_id AS "questId", revision, definition
           FROM games_atlas.quests WHERE cluster_id = $1
          ORDER BY quest_id, revision DESC`,
        [context.clusterId]
      );
      const quests = result.rows.filter((row) => {
        const parsed = definitionSchema.safeParse(row.definition);
        return parsed.success && questMatchesScope(parsed.data, context.clusterId, context.gridId, params.data.serverId);
      });
      return { data: quests, requestId: request.id };
    } catch (error) {
      request.log.error({ err: error }, "ATLAS quest listing failed");
      return sendError(reply, 500, "QUEST_LIST_FAILED", "Quest definitions could not be loaded.");
    }
  });

  app.get("/integrations/servers/:serverId/quests/:questId/progress/:platformId", async (request, reply) => {
    if (!pool) return sendError(reply, 503, "DATABASE_UNAVAILABLE", "Quest progress storage is temporarily unavailable.");
    const params = z.object({ serverId: uuid, questId: uuid, platformId: z.string().trim().min(1).max(128) }).safeParse(request.params);
    const query = z.object({ revision: z.coerce.number().int().min(1) }).safeParse(request.query);
    if (!params.success || !query.success) return sendError(reply, 400, "VALIDATION_ERROR", "A valid server, quest, player ID, and quest revision are required.");
    const actorId = await requireServicePermission(request, reply, "quests.progress.read", "server", params.data.serverId);
    if (!actorId) return;
    try {
      const context = await getAtlasServerContext(pool, params.data.serverId);
      if (!context) return sendError(reply, 404, "ATLAS_SERVER_NOT_FOUND", "The ATLAS server or grid was not found.");
      const quest = await pool.query(
        `SELECT definition FROM games_atlas.quests WHERE cluster_id = $1 AND quest_id = $2 AND revision = $3`,
        [context.clusterId, params.data.questId, query.data.revision]
      );
      const parsed = definitionSchema.safeParse(quest.rows[0]?.definition);
      if (!parsed.success || !questMatchesScope(parsed.data, context.clusterId, context.gridId, params.data.serverId)) {
        return sendError(reply, 404, "QUEST_NOT_FOUND", "The enabled quest revision was not found for this server.");
      }
      const progress = await pool.query(
        `SELECT state, version, updated_at AS "updatedAt" FROM games_atlas.quest_progress
          WHERE cluster_id = $1 AND quest_id = $2 AND quest_revision = $3 AND player_platform_id = $4`,
        [context.clusterId, params.data.questId, query.data.revision, params.data.platformId]
      );
      return { data: progress.rows[0] ?? { state: null, version: 0, updatedAt: null }, requestId: request.id };
    } catch (error) {
      request.log.error({ err: error }, "ATLAS quest progress read failed");
      return sendError(reply, 500, "QUEST_PROGRESS_READ_FAILED", "Quest progress could not be loaded.");
    }
  });

  app.post("/integrations/servers/:serverId/quests/:questId/progress", async (request, reply) => {
    if (!pool) return sendError(reply, 503, "DATABASE_UNAVAILABLE", "Quest progress storage is temporarily unavailable.");
    const params = z.object({ serverId: uuid, questId: uuid }).safeParse(request.params);
    const body = z.object({
      revision: z.number().int().min(1),
      eventId: uuid,
      leaseToken: uuid,
      platformId: z.string().trim().min(1).max(128),
      expectedVersion: z.number().int().min(0),
      state: progressStateSchema
    }).strict().safeParse(request.body);
    if (!params.success || !body.success || body.data.state.questId !== params.data?.questId || body.data.state.questRevision !== body.data.revision || !body.data.state.processedEventIds.includes(body.data.eventId) || Object.keys(body.data.state.players).length !== 1 || !Object.hasOwn(body.data.state.players, body.data.platformId)) {
      return sendError(reply, 400, "VALIDATION_ERROR", "A valid progress state tied to this quest, player, revision, and outbox event is required.");
    }
    const actorId = await requireServicePermission(request, reply, "quests.progress.write", "server", params.data.serverId);
    if (!actorId) return;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const context = await getAtlasServerContext(client, params.data.serverId);
      if (!context) {
        await client.query("ROLLBACK");
        return sendError(reply, 404, "ATLAS_SERVER_NOT_FOUND", "The ATLAS server or grid was not found.");
      }
      const eventResult = await client.query(
        `SELECT payload, claimed_by_principal_id, lease_token, (lease_expires_at > clock_timestamp()) AS lease_active
           FROM operations.event_outbox
          WHERE id = $1 AND event_type = 'game.event.received' AND payload->>'serverId' = $2
          FOR UPDATE`,
        [body.data.eventId, params.data.serverId]
      );
      const event = eventResult.rows[0];
      if (!event || event.claimed_by_principal_id !== actorId || event.lease_token !== body.data.leaseToken || event.lease_active !== true) {
        await client.query("ROLLBACK");
        return sendError(reply, 409, "EVENT_LEASE_INVALID", "The service must hold the active Core event lease to persist quest progress.");
      }
      const eventPayload = event.payload as { clusterId?: string; gridId?: string; eventType?: string; payload?: { platformId?: string } };
      if (eventPayload.clusterId?.toLowerCase() !== context.clusterId || eventPayload.gridId !== context.gridId || eventPayload.payload?.platformId !== body.data.platformId) {
        await client.query("ROLLBACK");
        return sendError(reply, 409, "QUEST_EVENT_SCOPE_MISMATCH", "The event identity or grid does not match this quest progress request.");
      }
      const questResult = await client.query(
        `SELECT definition FROM games_atlas.quests WHERE cluster_id = $1 AND quest_id = $2 AND revision = $3`,
        [context.clusterId, params.data.questId, body.data.revision]
      );
      const parsedQuest = definitionSchema.safeParse(questResult.rows[0]?.definition);
      if (!parsedQuest.success || !questMatchesScope(parsedQuest.data, context.clusterId, context.gridId, params.data.serverId)) {
        await client.query("ROLLBACK");
        return sendError(reply, 404, "QUEST_NOT_FOUND", "The enabled quest revision was not found for this server.");
      }
      const definition = parsedQuest.data;
      const player = body.data.state.players[body.data.platformId]!;
      const objectiveIds = Object.keys(player.objectives);
      if (objectiveIds.some((id) => !definition.objectives.some((objective) => objective.id === id)) ||
          definition.objectives.filter((objective) => objective.eventType === eventPayload.eventType).length === 0 ||
          definition.objectives.some((objective) => (player.objectives[objective.id] ?? 0) > objective.targetCount)) {
        await client.query("ROLLBACK");
        return sendError(reply, 400, "QUEST_PROGRESS_INVALID", "Progress contains unsupported objectives or counts for this event.");
      }
      const completeFromCounts = definition.objectives.every((objective) => (player.objectives[objective.id] ?? 0) >= objective.targetCount);
      if (player.completed !== completeFromCounts || (player.completed && !player.completedAt) || (!player.completed && player.completedAt !== null)) {
        await client.query("ROLLBACK");
        return sendError(reply, 400, "QUEST_PROGRESS_INVALID", "Completion state does not match the objective counts.");
      }

      const duplicate = await client.query(
        `SELECT 1 FROM games_atlas.quest_event_receipts WHERE cluster_id = $1 AND quest_id = $2 AND quest_revision = $3 AND event_id = $4`,
        [context.clusterId, params.data.questId, body.data.revision, body.data.eventId]
      );
      if (duplicate.rowCount) {
        const current = await client.query(
          `SELECT version FROM games_atlas.quest_progress WHERE cluster_id = $1 AND quest_id = $2 AND quest_revision = $3 AND player_platform_id = $4`,
          [context.clusterId, params.data.questId, body.data.revision, body.data.platformId]
        );
        await client.query("COMMIT");
        return reply.code(200).send({ data: { durable: true, duplicate: true, version: current.rows[0]?.version ?? 0 }, requestId: request.id });
      }

      const current = await client.query(
        `SELECT state, version FROM games_atlas.quest_progress
          WHERE cluster_id = $1 AND quest_id = $2 AND quest_revision = $3 AND player_platform_id = $4
          FOR UPDATE`,
        [context.clusterId, params.data.questId, body.data.revision, body.data.platformId]
      );
      const currentRow = current.rows[0] as { state: { players?: Record<string, { objectives?: Record<string, number>; completed?: boolean; completedAt?: string | null }> } | null; version: number } | undefined;

      const finalLease = await client.query<{ lease_active: boolean }>(
        `SELECT (lease_expires_at > clock_timestamp()) AS lease_active
           FROM operations.event_outbox
          WHERE id = $1 AND event_type = 'game.event.received'
            AND payload->>'serverId' = $2
            AND claimed_by_principal_id = $3 AND lease_token = $4
            AND processed_at IS NULL`,
        [body.data.eventId, params.data.serverId, actorId, body.data.leaseToken]
      );
      if (finalLease.rows[0]?.lease_active !== true) {
        await client.query("ROLLBACK");
        return sendError(reply, 409, "EVENT_LEASE_INVALID", "The service must still hold the active Core event lease to persist quest progress.");
      }

      if ((currentRow?.version ?? 0) !== body.data.expectedVersion) {
        await client.query("ROLLBACK");
        return sendError(reply, 409, "QUEST_PROGRESS_CONFLICT", "Quest progress changed concurrently. Reload and reapply this event.");
      }
      const previousPlayer = currentRow?.state?.players?.[body.data.platformId];
      if (previousPlayer) {
        for (const objective of definition.objectives) {
          if ((player.objectives[objective.id] ?? 0) < (previousPlayer.objectives?.[objective.id] ?? 0)) {
            await client.query("ROLLBACK");
            return sendError(reply, 409, "QUEST_PROGRESS_REGRESSION", "Quest objective progress cannot move backwards.");
          }
        }
        if (previousPlayer.completed && !player.completed) {
          await client.query("ROLLBACK");
          return sendError(reply, 409, "QUEST_PROGRESS_REGRESSION", "Completed quest progress cannot be reopened.");
        }
      }

      // Core independently enforces the reducer's one-increment-per-event contract.
      // Never trust a worker-supplied aggregate progress state, even from an authorized service.
      for (const objective of definition.objectives) {
        const previousCount = previousPlayer?.objectives?.[objective.id] ?? 0;
        const expectedCount = previousPlayer?.completed
          ? previousCount
          : objective.eventType === eventPayload.eventType
            ? Math.min(objective.targetCount, previousCount + 1)
            : previousCount;
        if ((player.objectives[objective.id] ?? 0) !== expectedCount) {
          await client.query("ROLLBACK");
          return sendError(reply, 400, "QUEST_PROGRESS_INVALID", "Each objective must reflect exactly one increment for this event, capped at its target.");
        }
      }

      await client.query(
        `INSERT INTO games_atlas.quest_event_receipts (cluster_id, quest_id, quest_revision, event_id, server_id, player_platform_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [context.clusterId, params.data.questId, body.data.revision, body.data.eventId, params.data.serverId, body.data.platformId]
      );
      const durableState = { ...body.data.state, processedEventIds: [] };
      const stateJson = JSON.stringify(durableState);
      const saved = currentRow
        ? await client.query(
            `UPDATE games_atlas.quest_progress SET state = $5::jsonb, version = version + 1, updated_at = NOW()
              WHERE cluster_id = $1 AND quest_id = $2 AND quest_revision = $3 AND player_platform_id = $4
              RETURNING version`,
            [context.clusterId, params.data.questId, body.data.revision, body.data.platformId, stateJson]
          )
        : await client.query(
            `INSERT INTO games_atlas.quest_progress (cluster_id, quest_id, quest_revision, player_platform_id, state, version)
             VALUES ($1, $2, $3, $4, $5::jsonb, 1)
             ON CONFLICT (cluster_id, quest_id, quest_revision, player_platform_id) DO NOTHING
             RETURNING version`,
            [context.clusterId, params.data.questId, body.data.revision, body.data.platformId, stateJson]
          );
      if (!currentRow && !saved.rows[0]) {
        await client.query("ROLLBACK");
        return sendError(reply, 409, "QUEST_PROGRESS_CONFLICT", "Quest progress was initialized concurrently. Reload and reapply this event.");
      }
      await client.query(
        `INSERT INTO operations.audit_logs (actor_principal_id, action, resource_type, resource_id, outcome, metadata)
         VALUES ($1, 'atlas.quest.progress.persist', 'atlas_quest', $2, 'success', $3::jsonb)`,
        [actorId, params.data.questId, JSON.stringify({ serverId: params.data.serverId, revision: body.data.revision, eventId: body.data.eventId, version: saved.rows[0]?.version })]
      );
      await client.query("COMMIT");
      return reply.code(201).send({ data: { durable: true, duplicate: false, version: saved.rows[0]?.version ?? 1 }, requestId: request.id });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      request.log.error({ err: error }, "ATLAS quest progress persistence failed");
      return sendError(reply, 500, "QUEST_PROGRESS_PERSIST_FAILED", "Quest progress could not be persisted.");
    } finally {
      client.release();
    }
  });
}
