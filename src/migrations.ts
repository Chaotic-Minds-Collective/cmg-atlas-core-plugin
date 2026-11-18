import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface MigrationClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const MIGRATION_LOCK = "1129137987";

/** Serialize the complete run on one session and verify immutable migration bytes. */
export async function runMigrations(
  client: MigrationClient,
  directory: string,
  { baselineLegacy = false, log = console.info }: { baselineLegacy?: boolean; log?: (message: string) => void } = {}
): Promise<void> {
  await client.query("SELECT pg_advisory_lock($1::bigint)", [MIGRATION_LOCK]);
  try {
    await client.query("BEGIN");
    try {
      await client.query("CREATE SCHEMA IF NOT EXISTS operations");
      await client.query(`CREATE TABLE IF NOT EXISTS operations.schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        checksum_sha256 TEXT
      )`);
      await client.query("ALTER TABLE operations.schema_migrations ADD COLUMN IF NOT EXISTS checksum_sha256 TEXT");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }

    const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
    const applied = await client.query("SELECT filename, checksum_sha256 FROM operations.schema_migrations ORDER BY filename");
    const recorded = new Map(applied.rows.map((row) => [String(row.filename), row.checksum_sha256]));
    for (const filename of recorded.keys()) {
      if (!files.includes(filename)) throw new Error(`Applied migration is missing from disk: ${filename}`);
    }

    for (const filename of files) {
      const bytes = await readFile(join(directory, filename));
      const checksum = createHash("sha256").update(bytes).digest("hex");
      if (recorded.has(filename)) {
        const previous = recorded.get(filename);
        if (previous == null) {
          if (!baselineLegacy) throw new Error(`Review legacy migration ${filename} before setting BASELINE_LEGACY_MIGRATIONS=true once.`);
          await client.query("UPDATE operations.schema_migrations SET checksum_sha256 = $2 WHERE filename = $1 AND checksum_sha256 IS NULL", [filename, checksum]);
          log(`Baselined legacy migration ${filename}; SQL was not rerun.`);
        } else if (previous !== checksum) {
          throw new Error(`Migration checksum mismatch: ${filename}`);
        }
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(bytes.toString("utf8"));
        await client.query("INSERT INTO operations.schema_migrations (filename, checksum_sha256) VALUES ($1, $2)", [filename, checksum]);
        await client.query("COMMIT");
        log(`Applied ${filename}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK]);
  }
}
