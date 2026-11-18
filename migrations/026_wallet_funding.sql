CREATE TABLE commerce.product_wallet_mappings (
  product_id UUID PRIMARY KEY REFERENCES commerce.products(id) ON DELETE RESTRICT,
  currency_code CHAR(3) NOT NULL CHECK (btrim(currency_code) ~ '^[A-Z]{3}$'),
  credit_amount_minor BIGINT NOT NULL CHECK (credit_amount_minor > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX product_wallet_mappings_currency_idx
  ON commerce.product_wallet_mappings (currency_code);

ALTER TABLE commerce.order_items
  ADD COLUMN wallet_credit_currency CHAR(3),
  ADD COLUMN wallet_credit_unit_minor BIGINT,
  ADD CONSTRAINT order_items_wallet_credit_snapshot_check CHECK (
    (wallet_credit_currency IS NULL AND wallet_credit_unit_minor IS NULL)
    OR (
      wallet_credit_currency IS NOT NULL
      AND btrim(wallet_credit_currency) ~ '^[A-Z]{3}$'
      AND wallet_credit_unit_minor IS NOT NULL
      AND wallet_credit_unit_minor > 0
    )
  );

CREATE INDEX order_items_wallet_credit_currency_idx
  ON commerce.order_items (wallet_credit_currency)
  WHERE wallet_credit_currency IS NOT NULL;
