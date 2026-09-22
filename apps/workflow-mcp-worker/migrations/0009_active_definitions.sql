-- T05: active registry pointer only; no admission/scheduler cutover.
CREATE TABLE IF NOT EXISTS workflow_active_definitions (
  workflow_id TEXT PRIMARY KEY,
  active_digest TEXT REFERENCES workflow_definition_versions(definition_digest),
  registry_revision INTEGER NOT NULL CHECK (registry_revision > 0),
  state TEXT NOT NULL CHECK (state IN ('enabled', 'disabled')),
  activated_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK ((state = 'enabled' AND active_digest IS NOT NULL) OR state = 'disabled')
);
CREATE INDEX IF NOT EXISTS idx_active_definitions_state
  ON workflow_active_definitions(state, workflow_id);

CREATE TABLE IF NOT EXISTS workflow_registry_actions (
  action_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  action_kind TEXT NOT NULL CHECK (action_kind IN ('activate', 'deactivate')),
  previous_digest TEXT,
  next_digest TEXT,
  expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0),
  resulting_revision INTEGER NOT NULL CHECK (resulting_revision > 0),
  repository_id TEXT NOT NULL,
  publisher_run_id TEXT NOT NULL,
  publisher_run_attempt INTEGER NOT NULL CHECK (publisher_run_attempt > 0),
  request_digest TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_registry_actions_workflow
  ON workflow_registry_actions(workflow_id, resulting_revision);
