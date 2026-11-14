CREATE TABLE operations.atlas_recovery_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id UUID NOT NULL REFERENCES core.servers(id) ON DELETE RESTRICT,
  cluster_id UUID NOT NULL REFERENCES core.clusters(id) ON DELETE RESTRICT,
  grid_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  snapshot_kind TEXT NOT NULL CHECK (snapshot_kind IN ('inventory', 'tame', 'ship')),
  asset_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  state JSONB NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  state_bytes INTEGER NOT NULL CHECK (state_bytes BETWEEN 1 AND 16777216),
  reason TEXT NOT NULL DEFAULT 'scheduled',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (server_id, snapshot_id)
);

CREATE INDEX atlas_recovery_asset_history_idx
  ON operations.atlas_recovery_snapshots
    (server_id, snapshot_kind, asset_id, captured_at DESC);

CREATE INDEX atlas_recovery_owner_history_idx
  ON operations.atlas_recovery_snapshots
    (server_id, owner_id, captured_at DESC);

INSERT INTO core.roles (role_key, description) VALUES
  ('recovery_snapshot_writer', 'Persist recovery snapshots for assigned ATLAS servers'),
  ('recovery_snapshot_reader', 'Read recovery snapshots for assigned ATLAS servers')
ON CONFLICT (role_key) DO NOTHING;

INSERT INTO core.permissions (permission_key, description) VALUES
  ('recovery.snapshots.write', 'Persist bounded recovery snapshots for assigned ATLAS servers'),
  ('recovery.snapshots.read', 'Read recovery snapshots for assigned ATLAS servers')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO core.role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM core.roles r
  CROSS JOIN core.permissions p
 WHERE (r.role_key = 'recovery_snapshot_writer' AND p.permission_key = 'recovery.snapshots.write')
    OR (r.role_key = 'recovery_snapshot_reader' AND p.permission_key = 'recovery.snapshots.read')
ON CONFLICT DO NOTHING;
