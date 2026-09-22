-- T07: approved, workflow/trigger/version-scoped webhook credential references.
-- Definitions cannot grant themselves access to arbitrary Worker env secrets.
-- OFF by default: no runtime reader switches to this table until T07 admission is verified.
CREATE TABLE IF NOT EXISTS workflow_webhook_secret_scopes (
  workflow_id TEXT NOT NULL,
  trigger_id TEXT NOT NULL,
  definition_digest TEXT NOT NULL REFERENCES workflow_definition_versions(definition_digest),
  secret_name TEXT NOT NULL,
  policy_revision INTEGER NOT NULL CHECK (policy_revision > 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  approved_at TEXT NOT NULL,
  PRIMARY KEY (workflow_id, trigger_id, definition_digest),
  CHECK (length(workflow_id) > 0 AND length(trigger_id) > 0),
  CHECK (length(secret_name) > 0 AND length(secret_name) <= 128),
  -- Protected platform credentials must never be usable as webhook tokens.
  CHECK (secret_name NOT IN ('DB', 'WORKFLOW', 'ARTIFACTS')
    AND secret_name NOT GLOB 'MCP_*'
    AND secret_name NOT GLOB 'EXECUTOR_*'
    AND secret_name NOT GLOB 'GITHUB_*'
    AND secret_name NOT GLOB 'ADMIN_*'
    AND secret_name NOT GLOB 'R2_*'
    AND secret_name NOT GLOB 'CF_*'
    AND secret_name NOT GLOB 'DYNAMIC_WORKFLOW_*')
);
CREATE INDEX IF NOT EXISTS idx_webhook_secret_scopes_digest
  ON workflow_webhook_secret_scopes(definition_digest, enabled);

-- A durable action claim makes an authorized publication replay distinguishable
-- from a concurrent attempt to bind a different token or stale policy.
CREATE TABLE IF NOT EXISTS webhook_secret_scope_actions (
  action_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  trigger_id TEXT NOT NULL,
  definition_digest TEXT NOT NULL,
  secret_name TEXT NOT NULL,
  expected_policy_revision INTEGER NOT NULL CHECK (expected_policy_revision > 0),
  resulting_policy_revision INTEGER NOT NULL CHECK (resulting_policy_revision = expected_policy_revision),
  created_at TEXT NOT NULL
);
