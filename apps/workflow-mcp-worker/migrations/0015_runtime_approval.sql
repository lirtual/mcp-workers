-- A single immutable approval/denial per exact Run/Step/Published Version.
-- The authoritative decision is stored before a best-effort native wake.
CREATE TABLE runtime_approval_gates (
 run_id TEXT NOT NULL, step_id TEXT NOT NULL, version_id TEXT NOT NULL,
 deadline_at INTEGER NOT NULL,
 PRIMARY KEY(run_id,step_id), FOREIGN KEY(run_id) REFERENCES runs(id)
);
CREATE TABLE runtime_approvals (
 run_id TEXT NOT NULL, step_id TEXT NOT NULL, version_id TEXT NOT NULL,
 decision TEXT NOT NULL CHECK(decision IN ('approved','denied')),
 created_at INTEGER NOT NULL, consumed_at INTEGER,
 PRIMARY KEY(run_id,step_id,version_id), FOREIGN KEY(run_id) REFERENCES runs(id)
);
