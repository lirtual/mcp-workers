PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workflow_definition_versions (
  definition_digest TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  dsl_version INTEGER NOT NULL,
  normalized_plan_json TEXT NOT NULL,
  source_path TEXT NOT NULL,
  source_commit TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_definition_versions_workflow
  ON workflow_definition_versions(workflow_id, created_at);

CREATE TABLE IF NOT EXISTS run_admissions (
  admission_key TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  workflow_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_key TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  run_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  definition_digest TEXT NOT NULL REFERENCES workflow_definition_versions(definition_digest),
  input_json TEXT NOT NULL,
  trigger_json TEXT NOT NULL,
  state TEXT NOT NULL,
  output_json TEXT,
  error_code TEXT,
  error_summary TEXT,
  engine_version TEXT,
  cf_workflow_instance_id TEXT NOT NULL,
  cf_workflow_version_id TEXT,
  cancel_requested_at TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_created
  ON workflow_runs(workflow_id, created_at);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_state
  ON workflow_runs(state);

CREATE TABLE IF NOT EXISTS step_runs (
  step_run_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  state TEXT NOT NULL,
  effective_policy_json TEXT,
  output_json TEXT,
  error_code TEXT,
  error_summary TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  UNIQUE(run_id, step_id)
);

CREATE INDEX IF NOT EXISTS idx_step_runs_run
  ON step_runs(run_id);

CREATE TABLE IF NOT EXISTS step_attempts (
  attempt_id TEXT PRIMARY KEY,
  step_run_id TEXT NOT NULL REFERENCES step_runs(step_run_id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  executor_type TEXT NOT NULL,
  state TEXT NOT NULL,
  terminal_result_json TEXT,
  error_code TEXT,
  error_summary TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  UNIQUE(step_run_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_step_attempts_step
  ON step_attempts(step_run_id, attempt_number);

CREATE TABLE IF NOT EXISTS workflow_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
  step_run_id TEXT,
  attempt_id TEXT,
  event_type TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_events_run
  ON workflow_events(run_id, event_id);
