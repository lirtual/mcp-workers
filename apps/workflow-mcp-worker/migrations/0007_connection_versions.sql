-- v0.2 T03: approved non-secret connection revisions and live controls.
-- This migration is additive; existing v0.1 runs retain the static compatibility mapping.
-- Never store credential bytes, tokens, or arbitrary Env values here.
CREATE TABLE IF NOT EXISTS connection_config_versions (
  connection_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (connection_id, version)
);

CREATE TABLE IF NOT EXISTS connection_controls (
  connection_id TEXT PRIMARY KEY,
  current_version INTEGER NOT NULL CHECK(current_version > 0),
  revision INTEGER NOT NULL CHECK(revision > 0),
  disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0, 1)),
  allowed_tools_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(connection_id, current_version)
    REFERENCES connection_config_versions(connection_id, version)
);

CREATE TABLE IF NOT EXISTS connection_admin_actions (
  action_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  action_kind TEXT NOT NULL CHECK(action_kind IN ('register', 'disable')),
  request_digest TEXT NOT NULL,
  resulting_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

-- Run pin is a compact map of connection IDs to approved revision numbers.
-- NULL means a pre-v0.2 run and must be interpreted using legacy static policy.
ALTER TABLE workflow_runs ADD COLUMN connection_versions_json TEXT;

-- One global monotonic publisher snapshot revision; independent Connection
-- revisions cannot be combined using MAX without losing intervening changes.
CREATE TABLE IF NOT EXISTS connection_policy_revision (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  revision INTEGER NOT NULL CHECK(revision > 0)
);
INSERT OR IGNORE INTO connection_policy_revision (singleton, revision) VALUES (1, 1);
