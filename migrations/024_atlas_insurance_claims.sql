ALTER TABLE operations.game_events
  DROP CONSTRAINT IF EXISTS game_events_event_type_check;

ALTER TABLE operations.game_events
  ADD CONSTRAINT game_events_event_type_check
  CHECK (event_type IN (
    'player.joined',
    'player.left',
    'player.connected',
    'player.disconnected',
    'player.chat',
    'player.died',
    'player.killed',
    'character.created',
    'character.transferred',
    'tribe.created',
    'tribe.member.joined',
    'tribe.member.left',
    'tribe.updated',
    'chat.global',
    'chat.tribe',
    'ship.sunk',
    'ship.retrieved',
    'structure.destroyed',
    'tame.created',
    'tame.died',
    'server.started',
    'server.stopped',
    'server.state.changed'
  ));

CREATE TABLE commerce.atlas_insurance_products (
  product_id UUID PRIMARY KEY REFERENCES commerce.products(id) ON DELETE RESTRICT,
  asset_kind TEXT NOT NULL CHECK (asset_kind IN ('tame', 'ship')),
  coverage_seconds INTEGER NOT NULL CHECK (coverage_seconds BETWEEN 1 AND 315360000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE operations.atlas_insurance_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id UUID NOT NULL REFERENCES core.users(principal_id) ON DELETE RESTRICT,
  entitlement_id UUID NOT NULL REFERENCES commerce.entitlements(id) ON DELETE RESTRICT,
  asset_kind TEXT NOT NULL CHECK (asset_kind IN ('tame', 'ship')),
  asset_id TEXT NOT NULL CHECK (length(btrim(asset_id)) BETWEEN 1 AND 256),
  owner_external_id TEXT NOT NULL CHECK (length(btrim(owner_external_id)) BETWEEN 1 AND 256),
  server_id UUID NOT NULL REFERENCES core.servers(id) ON DELETE RESTRICT,
  cluster_id UUID NOT NULL REFERENCES core.clusters(id) ON DELETE RESTRICT,
  grid_id TEXT NOT NULL CHECK (length(btrim(grid_id)) BETWEEN 1 AND 200),
  loss_event_record_id UUID NOT NULL REFERENCES operations.game_events(id) ON DELETE RESTRICT,
  loss_event_external_id TEXT NOT NULL,
  loss_occurred_at TIMESTAMPTZ NOT NULL,
  snapshot_id UUID NOT NULL REFERENCES operations.asset_snapshots(snapshot_id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'approved', 'denied')),
  reviewed_by UUID REFERENCES core.principals(id) ON DELETE RESTRICT,
  reviewed_at TIMESTAMPTZ,
  decision_note TEXT CHECK (decision_note IS NULL OR length(decision_note) <= 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (principal_id, idempotency_key),
  UNIQUE (loss_event_record_id),
  CHECK (
    (status = 'submitted' AND reviewed_by IS NULL AND reviewed_at IS NULL)
    OR (status IN ('approved', 'denied') AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);

CREATE INDEX atlas_insurance_claims_review_idx
  ON operations.atlas_insurance_claims (status, created_at)
  WHERE status = 'submitted';

CREATE INDEX atlas_insurance_claims_principal_idx
  ON operations.atlas_insurance_claims (principal_id, created_at DESC);

INSERT INTO core.permissions (permission_key, description)
VALUES ('atlas.insurance.claims.review', 'Review ATLAS tame and ship insurance claims and authorize recovery')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO core.role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM core.roles r
  CROSS JOIN core.permissions p
 WHERE r.role_key = 'platform_admin'
   AND p.permission_key = 'atlas.insurance.claims.review'
ON CONFLICT DO NOTHING;
