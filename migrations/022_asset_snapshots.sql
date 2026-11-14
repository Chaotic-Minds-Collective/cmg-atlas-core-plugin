CREATE TABLE operations.asset_snapshots (
  snapshot_id UUID PRIMARY KEY,
  server_id UUID NOT NULL REFERENCES core.servers(id) ON DELETE RESTRICT,
  cluster_id UUID NOT NULL REFERENCES core.clusters(id) ON DELETE RESTRICT,
  grid_id TEXT NOT NULL CHECK (length(btrim(grid_id)) BETWEEN 1 AND 200),
  kind TEXT NOT NULL CHECK (kind IN ('inventory', 'tame', 'ship')),
  asset_id TEXT NOT NULL CHECK (length(btrim(asset_id)) BETWEEN 1 AND 200),
  owner_id TEXT NOT NULL CHECK (length(btrim(owner_id)) BETWEEN 1 AND 200),
  captured_at TIMESTAMPTZ NOT NULL,
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 80),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  encryption_algorithm TEXT NOT NULL CHECK (encryption_algorithm = 'AES-256-GCM'),
  encryption_key_id TEXT NOT NULL CHECK (length(btrim(encryption_key_id)) BETWEEN 1 AND 200),
  nonce BYTEA NOT NULL CHECK (octet_length(nonce) = 12),
  auth_tag BYTEA NOT NULL CHECK (octet_length(auth_tag) = 16),
  ciphertext BYTEA NOT NULL CHECK (octet_length(ciphertext) BETWEEN 1 AND 1398104),
  ciphertext_bytes INTEGER NOT NULL CHECK (ciphertext_bytes = octet_length(ciphertext)),
  state_bytes INTEGER NOT NULL CHECK (state_bytes BETWEEN 1 AND 1048576),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX asset_snapshots_lookup_idx
  ON operations.asset_snapshots (server_id, kind, asset_id, captured_at DESC);
CREATE INDEX asset_snapshots_owner_idx
  ON operations.asset_snapshots (server_id, owner_id, captured_at DESC);

INSERT INTO core.roles (role_key, description)
VALUES ('asset_snapshot_manager', 'Store and retrieve encrypted recovery snapshots for assigned servers')
ON CONFLICT (role_key) DO NOTHING;

INSERT INTO core.permissions (permission_key, description) VALUES
  ('snapshots.write', 'Store encrypted recovery snapshots for assigned servers'),
  ('snapshots.read', 'Read encrypted recovery snapshots for assigned servers')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO core.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM core.roles r CROSS JOIN core.permissions p
WHERE r.role_key = 'asset_snapshot_manager'
  AND p.permission_key IN ('snapshots.write', 'snapshots.read')
ON CONFLICT DO NOTHING;
