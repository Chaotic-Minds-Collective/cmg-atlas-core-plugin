-- Provider-neutral ATLAS color-token application operations.
-- Color tokens are applied to player-selected assets by the installed game adapter.
-- Core deliberately stores the selected color as opaque JSON; it does not define a
-- native color catalog or claim that a game-side change succeeded.

CREATE TABLE commerce.atlas_color_token_products (
  product_id UUID PRIMARY KEY REFERENCES commerce.products(id) ON DELETE RESTRICT,
  token_kind TEXT NOT NULL CHECK (token_kind IN ('ship', 'tame', 'armor')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION commerce.guard_atlas_color_token_product()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  product_type_value TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('atlas.color_token.product'), hashtext(NEW.product_id::text));

  SELECT p.product_type
    INTO product_type_value
    FROM commerce.products p
   WHERE p.id = NEW.product_id
   FOR KEY SHARE;

  IF product_type_value IS DISTINCT FROM 'game_entitlement' THEN
    RAISE EXCEPTION 'ATLAS color-token products must use the game_entitlement product type'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM commerce.product_game_mappings pgm
     WHERE pgm.product_id = NEW.product_id
  ) THEN
    RAISE EXCEPTION 'ATLAS color-token products cannot use automatic reward delivery mappings'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER atlas_color_token_product_guard
BEFORE INSERT OR UPDATE OF product_id ON commerce.atlas_color_token_products
FOR EACH ROW
EXECUTE FUNCTION commerce.guard_atlas_color_token_product();

CREATE OR REPLACE FUNCTION commerce.guard_color_token_product_game_mapping()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('atlas.color_token.product'), hashtext(NEW.product_id::text));

  IF EXISTS (
    SELECT 1
      FROM commerce.atlas_color_token_products ctp
     WHERE ctp.product_id = NEW.product_id
  ) THEN
    RAISE EXCEPTION 'ATLAS color-token products cannot use automatic reward delivery mappings'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER product_game_mapping_color_token_guard
BEFORE INSERT OR UPDATE OF product_id ON commerce.product_game_mappings
FOR EACH ROW
EXECUTE FUNCTION commerce.guard_color_token_product_game_mapping();

CREATE OR REPLACE FUNCTION commerce.guard_color_token_product_type()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('atlas.color_token.product'), hashtext(NEW.id::text));

  IF NEW.product_type <> 'game_entitlement'
     AND EXISTS (
       SELECT 1
         FROM commerce.atlas_color_token_products ctp
        WHERE ctp.product_id = NEW.id
     ) THEN
    RAISE EXCEPTION 'ATLAS color-token products must remain game_entitlement products'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER product_color_token_type_guard
BEFORE UPDATE OF product_type ON commerce.products
FOR EACH ROW
EXECUTE FUNCTION commerce.guard_color_token_product_type();

CREATE TABLE operations.atlas_color_token_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id UUID NOT NULL REFERENCES core.users(principal_id) ON DELETE RESTRICT,
  entitlement_id UUID NOT NULL REFERENCES commerce.entitlements(id) ON DELETE RESTRICT,
  product_id UUID NOT NULL REFERENCES commerce.products(id) ON DELETE RESTRICT,
  token_kind TEXT NOT NULL CHECK (token_kind IN ('ship', 'tame', 'armor')),
  owner_external_id TEXT NOT NULL CHECK (length(btrim(owner_external_id)) BETWEEN 1 AND 256),
  server_id UUID NOT NULL REFERENCES core.servers(id) ON DELETE RESTRICT,
  cluster_id UUID NOT NULL REFERENCES core.clusters(id) ON DELETE RESTRICT,
  grid_id TEXT NOT NULL CHECK (length(btrim(grid_id)) BETWEEN 1 AND 200),
  asset_id TEXT NOT NULL CHECK (length(btrim(asset_id)) BETWEEN 1 AND 256),
  selected_color JSONB NOT NULL CHECK (selected_color <> 'null'::jsonb),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'applied', 'failed')),
  claimed_by_principal_id UUID REFERENCES core.principals(id) ON DELETE RESTRICT,
  lease_expires_at TIMESTAMPTZ,
  lease_token UUID,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error_code TEXT CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_.-]{1,100}$'),
  applied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (principal_id, idempotency_key),
  CHECK (
    (status = 'processing'
      AND claimed_by_principal_id IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND lease_token IS NOT NULL)
    OR
    (status <> 'processing'
      AND claimed_by_principal_id IS NULL
      AND lease_expires_at IS NULL
      AND lease_token IS NULL)
  ),
  CHECK ((status = 'applied' AND applied_at IS NOT NULL) OR (status <> 'applied' AND applied_at IS NULL)),
  CHECK ((status = 'failed' AND error_code IS NOT NULL) OR (status <> 'failed' AND error_code IS NULL))
);

CREATE INDEX atlas_color_token_applications_claim_idx
  ON operations.atlas_color_token_applications (server_id, created_at, id)
  WHERE status IN ('pending', 'processing');

CREATE INDEX atlas_color_token_applications_entitlement_idx
  ON operations.atlas_color_token_applications (entitlement_id, status)
  WHERE status IN ('pending', 'processing', 'applied');

CREATE INDEX atlas_color_token_applications_principal_idx
  ON operations.atlas_color_token_applications (principal_id, created_at DESC);

INSERT INTO core.roles (role_key, description)
VALUES ('atlas_color_token_worker', 'Claim and acknowledge ATLAS color-token applications for assigned servers')
ON CONFLICT (role_key) DO NOTHING;

INSERT INTO core.permissions (permission_key, description) VALUES
  ('atlas.color_tokens.claim', 'Claim ATLAS color-token applications for assigned servers'),
  ('atlas.color_tokens.ack', 'Acknowledge ATLAS color-token application outcomes for assigned servers')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO core.role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM core.roles r
  CROSS JOIN core.permissions p
 WHERE r.role_key = 'atlas_color_token_worker'
   AND p.permission_key IN ('atlas.color_tokens.claim', 'atlas.color_tokens.ack')
ON CONFLICT DO NOTHING;
