PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
  step_run_id TEXT NOT NULL REFERENCES step_runs(step_run_id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES step_attempts(attempt_id) ON DELETE CASCADE,
  object_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  expected_size INTEGER NOT NULL,
  expected_sha256 TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'allocated'
    CHECK (state IN ('allocated', 'ready')),
  size INTEGER,
  sha256 TEXT,
  created_at TEXT NOT NULL,
  finalized_at TEXT,
  UNIQUE(attempt_id, name)
);

CREATE INDEX IF NOT EXISTS idx_artifacts_run_state
  ON artifacts(run_id, state, created_at);

CREATE INDEX IF NOT EXISTS idx_artifacts_attempt
  ON artifacts(attempt_id, created_at);
