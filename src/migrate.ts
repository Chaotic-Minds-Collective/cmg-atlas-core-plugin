import { join } from "node:path";
import { pool } from "./db.js";
import { runMigrations } from "./migrations.js";

if (!pool) throw new Error("DATABASE_URL is required to run migrations.");

const client = await pool.connect();
try {
  await runMigrations(client, join(process.cwd(), "migrations"), {
    baselineLegacy: process.env.BASELINE_LEGACY_MIGRATIONS === "true"
  });
} finally {
  client.release();
  await pool.end();
}
