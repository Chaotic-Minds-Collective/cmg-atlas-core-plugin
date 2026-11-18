# Coordinated migration integrity and reward-fencing rollout

Coordinate with cmg-sdk contract 0.4.0 (SDK draft PR #5). Validate both drafts in an isolated test environment before enabling fulfillment. No connected database or game server was changed.

The runner locks the entire session and records SHA-256 hashes of the actual SQL bytes. Changed or missing applied migrations fail closed. Historical full filenames, including both 022-prefixed files, remain unchanged. Do not rename applied migrations.

For historical records without hashes, first compare the actual previously applied SQL with these files. Only after operator review set BASELINE_LEGACY_MIGRATIONS=true for one controlled run, then remove it. Baselining stores hashes without rerunning old SQL and is not proof of previously unverified history.

Migration 025 adds a per-claim token. Claims/reclaims rotate it and acknowledgements must echo it; the same service cannot acknowledge an obsolete claim. Keep the final token for idempotent duplicate acknowledgements. Pause workers during rollout and allow old leases to expire. Requests without tokens fail closed.

Fencing API acknowledgement is not exactly-once game delivery. Game handlers still require durable idempotencyKey receipts and reconciliation of uncertain grants. This change enables no worker, item-grant adapter or live payments.
