-- One runtime decision for an exact Run, Step, and Published Version.
-- The workflow wake is not the decision. consumed_at authorizes one dispatch.
-- It is not proof of human presence. Connection revocation stays a separate row.
CREATE TABLE IF NOT EXISTS runtime_approvals (
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'denied')),
  created_at INTEGER NOT NULL,
  consumed_at INTEGER,
  PRIMARY KEY (run_id, step_id, version_id)
);
-- The deadline is fixed when the step first reaches the gate.
CREATE TABLE IF NOT EXISTS runtime_approval_gates (
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  deadline_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, step_id)
);
