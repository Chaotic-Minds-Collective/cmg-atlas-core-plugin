-- Preserve role-assignment history while allowing expired grants to be re-issued.
-- ended_at is an explicit lifecycle marker; authorization still checks expires_at.

ALTER TABLE core.principal_role_assignments
  ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ;

UPDATE core.principal_role_assignments
   SET ended_at = expires_at
 WHERE ended_at IS NULL
   AND expires_at IS NOT NULL
   AND expires_at <= NOW();

DROP INDEX IF EXISTS core.principal_role_scope_uq;

CREATE UNIQUE INDEX principal_role_scope_active_uq
  ON core.principal_role_assignments
    (principal_id, role_id, scope_type, COALESCE(scope_id, ''))
  WHERE ended_at IS NULL;
