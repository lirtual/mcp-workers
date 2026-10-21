-- S3 staged GitHub executor — deploy to an isolated D1 only until final approval.
-- One row is the logical Attempt AND its single physical candidate authority.
-- GitHub OIDC only authenticates the candidate; the confirmed dispatch row
-- is still required before an atomic Claim can grant business execution.
CREATE TABLE IF NOT EXISTS step_attempts (
 attempt_id TEXT PRIMARY KEY,
 run_id TEXT NOT NULL,
 step_id TEXT NOT NULL,
 capability_id TEXT NOT NULL CHECK(capability_id='heavy.github.echo'),
 dispatch_id TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL DEFAULT 'created'
   CHECK(state IN ('created','confirmed','dispatch_unknown','rejected','claimed','succeeded','failed','cancelled')),
 repository TEXT NOT NULL,
 repository_id TEXT NOT NULL,
 workflow_ref TEXT NOT NULL,
 ref TEXT NOT NULL,
 candidate_run_id INTEGER,
 candidate_run_attempt INTEGER,
 owner_run_id INTEGER,
 owner_run_attempt INTEGER,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 UNIQUE(run_id,step_id),
 FOREIGN KEY(run_id) REFERENCES runs(id),
 CHECK ((state IN ('created','dispatch_unknown','rejected') AND owner_run_id IS NULL)
    OR (state IN ('confirmed','claimed','succeeded','failed','cancelled'))),
 CHECK (owner_run_id IS NULL OR (owner_run_id=candidate_run_id
   AND owner_run_attempt=candidate_run_attempt))
);
CREATE INDEX IF NOT EXISTS step_attempts_by_run ON step_attempts(run_id);
