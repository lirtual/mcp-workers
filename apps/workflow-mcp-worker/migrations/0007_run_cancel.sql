-- The cancel request is durable. It is not evidence the Run or GitHub job stopped.
-- cancel_effect records one external cancel attempt: acknowledged or unknown.
-- Unknown is not retried, and neither value is a force-cancel.
ALTER TABLE runs ADD COLUMN cancel_requested_at INTEGER;
ALTER TABLE step_attempts ADD COLUMN cancel_effect TEXT
  CHECK (cancel_effect IS NULL OR cancel_effect IN ('acknowledged','unknown'));
