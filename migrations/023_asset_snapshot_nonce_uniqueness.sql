-- Fail rather than silently discard snapshots if existing envelopes reuse a nonce.
ALTER TABLE operations.asset_snapshots
  ADD CONSTRAINT asset_snapshots_key_nonce_unique UNIQUE (encryption_key_id, nonce);
