-- Active grants are rechecked before a protected effect. Revocation blocks a
-- later dispatch. A row already marked dispatched is never rewritten as a rollback.
CREATE TABLE IF NOT EXISTS grant_revocations (
  workflow_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  grant_key TEXT NOT NULL,
  revoked_at INTEGER NOT NULL,
  PRIMARY KEY (version_id, grant_key)
);
CREATE TABLE IF NOT EXISTS protected_effects (
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  grant_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('dispatching','succeeded','indeterminate')),
  result TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, step_id)
);
