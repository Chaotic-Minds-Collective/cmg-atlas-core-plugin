-- Park uncertain external game grants until a platform administrator reconciles them.
ALTER TABLE commerce.reward_queue
  DROP CONSTRAINT reward_queue_status_check,
  ADD CONSTRAINT reward_queue_status_check
    CHECK (status IN ('pending', 'processing', 'delivered', 'failed', 'cancelled', 'manual_review'));

ALTER TABLE commerce.reward_attempts
  DROP CONSTRAINT reward_attempts_outcome_check,
  ADD CONSTRAINT reward_attempts_outcome_check
    CHECK (outcome IN ('success', 'failure', 'manual_review'));
