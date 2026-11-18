-- Additive per-claim fencing. Existing filenames and historical records stay intact.
-- A fresh opaque token is generated each time a reward is claimed or reclaimed.
ALTER TABLE commerce.reward_queue ADD COLUMN lease_token UUID;
COMMENT ON COLUMN commerce.reward_queue.lease_token IS
  'Opaque per-claim fence; retained on terminal delivery to validate duplicate acknowledgements.';
