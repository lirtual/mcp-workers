ALTER TABLE step_attempts ADD COLUMN dispatch_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE step_attempts ADD COLUMN claim_nonce_hash TEXT;
ALTER TABLE step_attempts ADD COLUMN claim_owner TEXT;
ALTER TABLE step_attempts ADD COLUMN claim_deadline TEXT;
ALTER TABLE step_attempts ADD COLUMN claimed_at TEXT;
ALTER TABLE step_attempts ADD COLUMN github_run_id TEXT;
ALTER TABLE step_attempts ADD COLUMN github_run_attempt INTEGER;
ALTER TABLE step_attempts ADD COLUMN github_workflow_sha TEXT;
ALTER TABLE step_attempts ADD COLUMN expected_repository_id TEXT;
ALTER TABLE step_attempts ADD COLUMN expected_workflow_ref TEXT;
ALTER TABLE step_attempts ADD COLUMN expected_ref TEXT;
ALTER TABLE step_attempts ADD COLUMN expected_workflow_sha TEXT;
ALTER TABLE step_attempts ADD COLUMN execution_manifest_json TEXT;

CREATE TABLE IF NOT EXISTS executor_dispatches (
  attempt_id TEXT NOT NULL REFERENCES step_attempts(attempt_id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  dispatched_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('accepted', 'unknown', 'failed')),
  returned_github_run_id TEXT,
  error_summary TEXT,
  PRIMARY KEY(attempt_id, generation)
);

CREATE INDEX IF NOT EXISTS idx_executor_dispatches_attempt
  ON executor_dispatches(attempt_id, generation);

CREATE TABLE IF NOT EXISTS callback_inbox (
  callback_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES step_attempts(attempt_id) ON DELETE CASCADE,
  github_run_id TEXT NOT NULL,
  github_run_attempt INTEGER NOT NULL,
  callback_kind TEXT NOT NULL,
  result_json TEXT NOT NULL,
  received_at TEXT NOT NULL,
  notification_attempt_count INTEGER NOT NULL DEFAULT 0,
  next_notification_at TEXT,
  notified_at TEXT,
  ignored_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_callback_inbox_attempt
  ON callback_inbox(attempt_id, received_at);
CREATE INDEX IF NOT EXISTS idx_callback_inbox_notification
  ON callback_inbox(notified_at, next_notification_at);
