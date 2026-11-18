import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { runMigrations } from "../dist/migrations.js";
const hash = (s) => createHash("sha256").update(s).digest("hex");
async function fixture(t, rows = [], sql = "SELECT 1;") {
  const dir = await mkdtemp(join(tmpdir(), "cmg-migration-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "001_test.sql"), sql);
  const calls = [];
  const client = { query: async (text, values = []) => {
    calls.push({ text, values });
    if (text.startsWith("SELECT filename")) return { rows };
    if (text === "FAIL;") throw new Error("synthetic failure");
    return { rows: [] };
  } };
  return { client, dir, calls };
}
test("locks the entire run and stores exact SQL checksums", async (t) => {
  const f = await fixture(t); await runMigrations(f.client, f.dir, { log() {} });
  assert.match(f.calls[0].text, /pg_advisory_lock/);
  assert.match(f.calls.at(-1).text, /pg_advisory_unlock/);
  assert.deepEqual(f.calls.find((c) => c.text.startsWith("INSERT INTO operations.schema_migrations")).values, ["001_test.sql", hash("SELECT 1;")]);
});
test("unchanged applied SQL is not rerun", async (t) => {
  const f = await fixture(t, [{ filename: "001_test.sql", checksum_sha256: hash("SELECT 1;") }]);
  await runMigrations(f.client, f.dir, { log() {} });
  assert.equal(f.calls.some((c) => c.text === "SELECT 1;"), false);
});
test("checksum drift fails closed and releases the lock", async (t) => {
  const f = await fixture(t, [{ filename: "001_test.sql", checksum_sha256: hash("changed") }]);
  await assert.rejects(runMigrations(f.client, f.dir), /checksum mismatch/);
  assert.match(f.calls.at(-1).text, /pg_advisory_unlock/);
});
test("legacy baselines require explicit consent and never rerun SQL", async (t) => {
  const f = await fixture(t, [{ filename: "001_test.sql", checksum_sha256: null }]);
  await assert.rejects(runMigrations(f.client, f.dir), /BASELINE_LEGACY_MIGRATIONS/);
  f.calls.length = 0;
  await runMigrations(f.client, f.dir, { baselineLegacy: true, log() {} });
  assert.equal(f.calls.some((c) => c.text === "SELECT 1;"), false);
  assert.equal(f.calls.find((c) => c.text.startsWith("UPDATE operations.schema_migrations")).values[1], hash("SELECT 1;"));
});
test("missing historical files are rejected", async (t) => {
  const f = await fixture(t, [{ filename: "000_missing.sql", checksum_sha256: hash("old") }]);
  await assert.rejects(runMigrations(f.client, f.dir), /missing from disk/);
});
test("failed SQL rolls back and unlocks without recording success", async (t) => {
  const f = await fixture(t, [], "FAIL;");
  await assert.rejects(runMigrations(f.client, f.dir), /synthetic failure/);
  assert.equal(f.calls.at(-2).text, "ROLLBACK");
  assert.match(f.calls.at(-1).text, /pg_advisory_unlock/);
  assert.equal(f.calls.some((c) => c.text.startsWith("INSERT INTO operations.schema_migrations")), false);
});
