-- Rebuild only the constrained attempt table. D1 keeps foreign keys enabled;
-- defer checking until the replacement has regained its original table name.
PRAGMA defer_foreign_keys = ON;
CREATE TABLE step_attempts_replacement (
 attempt_id TEXT PRIMARY KEY,
 run_id TEXT NOT NULL,
 step_id TEXT NOT NULL,
 capability_id TEXT NOT NULL CHECK(capability_id IN ('heavy.github.echo','github.workflow.check','github.action')),
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
INSERT INTO step_attempts_replacement
 SELECT attempt_id,run_id,step_id,capability_id,dispatch_id,state,
 repository,repository_id,workflow_ref,ref,candidate_run_id,
 candidate_run_attempt,owner_run_id,owner_run_attempt,created_at,updated_at
 FROM step_attempts;
DROP TABLE step_attempts;
ALTER TABLE step_attempts_replacement RENAME TO step_attempts;
CREATE INDEX step_attempts_by_run ON step_attempts(run_id);
