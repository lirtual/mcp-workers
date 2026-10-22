CREATE TABLE IF NOT EXISTS workflows (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, draft TEXT NOT NULL,
 draft_revision INTEGER NOT NULL DEFAULT 1, active_version_id TEXT,
 state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','active','paused')),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_versions (
 id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL,
 digest TEXT NOT NULL, plan TEXT NOT NULL, created_at INTEGER NOT NULL,
 FOREIGN KEY(workflow_id) REFERENCES workflows(id)
);
CREATE INDEX IF NOT EXISTS workflow_versions_by_workflow ON workflow_versions(workflow_id);
CREATE TABLE IF NOT EXISTS runs (
 id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, version_id TEXT NOT NULL,
 instance_id TEXT NOT NULL UNIQUE,
 admission_key TEXT, request_digest TEXT NOT NULL, inputs TEXT NOT NULL,
 start_state TEXT NOT NULL DEFAULT 'reserved',
 outcome TEXT NOT NULL DEFAULT 'queued', result TEXT, error_code TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 FOREIGN KEY(workflow_id) REFERENCES workflows(id),
 FOREIGN KEY(version_id) REFERENCES workflow_versions(id),
 UNIQUE(workflow_id,admission_key)
);
CREATE INDEX IF NOT EXISTS runs_by_workflow ON runs(workflow_id, created_at DESC);
CREATE TABLE IF NOT EXISTS run_steps (
 run_id TEXT NOT NULL, step_id TEXT NOT NULL,
 status TEXT NOT NULL, output TEXT, error_code TEXT,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(run_id,step_id), FOREIGN KEY(run_id) REFERENCES runs(id)
);
