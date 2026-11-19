import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "../dist/db.js";

test("expired role assignment can be closed and re-granted without deleting history", {
  skip: !pool ? "DATABASE_URL is not configured" : false,
}, async () => {
  const principalId = randomUUID();
  try {
    await pool.query("INSERT INTO core.principals (id, principal_type, status) VALUES ($1, 'user', 'active')", [principalId]);
    const role = await pool.query("SELECT id FROM core.roles WHERE role_key = 'player'");
    assert.equal(role.rowCount, 1, "player role must be seeded");

    const expired = await pool.query(
      `INSERT INTO core.principal_role_assignments
        (principal_id, role_id, scope_type, scope_id, expires_at)
       VALUES ($1, $2, 'platform', NULL, NOW() - INTERVAL '1 minute')
       RETURNING id`,
      [principalId, role.rows[0].id]
    );

    await pool.query(
      `UPDATE core.principal_role_assignments
          SET ended_at = expires_at
        WHERE principal_id = $1 AND role_id = $2
          AND scope_type = 'platform' AND scope_id IS NULL
          AND ended_at IS NULL AND expires_at <= NOW()`,
      [principalId, role.rows[0].id]
    );

    const renewed = await pool.query(
      `INSERT INTO core.principal_role_assignments
        (principal_id, role_id, scope_type, scope_id)
       VALUES ($1, $2, 'platform', NULL)
       RETURNING id`,
      [principalId, role.rows[0].id]
    );

    assert.notEqual(renewed.rows[0].id, expired.rows[0].id);
    const history = await pool.query(
      `SELECT id, ended_at FROM core.principal_role_assignments
        WHERE principal_id = $1 AND role_id = $2 AND scope_type = 'platform'
        ORDER BY granted_at, id`,
      [principalId, role.rows[0].id]
    );
    assert.equal(history.rowCount, 2);
    const previousGrant = history.rows.find((row) => row.id === expired.rows[0].id);
    const currentGrant = history.rows.find((row) => row.id === renewed.rows[0].id);
    assert.ok(previousGrant?.ended_at, "expired assignment must remain as ended history");
    assert.equal(currentGrant?.ended_at, null, "replacement assignment must be active");
  } finally {
    await pool.query("DELETE FROM core.principal_role_assignments WHERE principal_id = $1", [principalId]);
    await pool.query("DELETE FROM core.principals WHERE id = $1", [principalId]);
  }
});
