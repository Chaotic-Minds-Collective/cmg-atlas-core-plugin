CREATE TABLE games_atlas.quests (
  cluster_id UUID NOT NULL REFERENCES core.clusters(id) ON DELETE RESTRICT,
  quest_id UUID NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  definition JSONB NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  created_by UUID REFERENCES core.principals(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (cluster_id, quest_id, revision)
);
CREATE INDEX atlas_quests_cluster_latest_idx ON games_atlas.quests (cluster_id, quest_id, revision DESC);

CREATE TABLE games_atlas.quest_progress (
  cluster_id UUID NOT NULL,
  quest_id UUID NOT NULL,
  quest_revision INTEGER NOT NULL,
  player_platform_id TEXT NOT NULL CHECK (length(player_platform_id) BETWEEN 1 AND 128),
  state JSONB NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (cluster_id, quest_id, quest_revision, player_platform_id),
  FOREIGN KEY (cluster_id, quest_id, quest_revision)
    REFERENCES games_atlas.quests(cluster_id, quest_id, revision) ON DELETE RESTRICT
);
CREATE INDEX atlas_quest_progress_player_idx ON games_atlas.quest_progress (player_platform_id, updated_at DESC);

CREATE TABLE games_atlas.quest_event_receipts (
  cluster_id UUID NOT NULL,
  quest_id UUID NOT NULL,
  quest_revision INTEGER NOT NULL,
  event_id UUID NOT NULL,
  server_id UUID NOT NULL REFERENCES core.servers(id) ON DELETE RESTRICT,
  player_platform_id TEXT NOT NULL CHECK (length(player_platform_id) BETWEEN 1 AND 128),
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (cluster_id, quest_id, quest_revision, event_id),
  FOREIGN KEY (cluster_id, quest_id, quest_revision)
    REFERENCES games_atlas.quests(cluster_id, quest_id, revision) ON DELETE RESTRICT
);
CREATE INDEX atlas_quest_event_receipts_player_idx ON games_atlas.quest_event_receipts (player_platform_id, processed_at DESC);

INSERT INTO core.roles (role_key, description) VALUES
  ('atlas_quest_manager', 'Publish versioned ATLAS quest definitions for assigned clusters'),
  ('atlas_quest_runtime', 'Read ATLAS quests and persist progress for assigned servers')
ON CONFLICT (role_key) DO NOTHING;

INSERT INTO core.permissions (permission_key, description) VALUES
  ('quests.manage', 'Publish versioned ATLAS quest definitions for assigned clusters'),
  ('quests.read', 'Read enabled ATLAS quest definitions for assigned servers'),
  ('quests.progress.read', 'Read ATLAS player quest progress for assigned servers'),
  ('quests.progress.write', 'Persist idempotent ATLAS quest progress for assigned servers')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO core.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM core.roles r CROSS JOIN core.permissions p
WHERE r.role_key = 'atlas_quest_manager' AND p.permission_key = 'quests.manage'
ON CONFLICT DO NOTHING;

INSERT INTO core.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM core.roles r CROSS JOIN core.permissions p
WHERE r.role_key = 'atlas_quest_runtime'
  AND p.permission_key IN ('events.claim', 'events.ack', 'quests.read', 'quests.progress.read', 'quests.progress.write')
ON CONFLICT DO NOTHING;
