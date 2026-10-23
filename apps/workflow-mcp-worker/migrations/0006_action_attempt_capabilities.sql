-- Rebuild only the constrained attempt table. D1 keeps foreign keys enabled;
-- defer checking until the replacement has regained its original table name.
PRAGMA defer_foreign_keys = ON;
-- Preserve callback receipts while both parent and child are reconstructed
-- under the migration transaction; dropping only the parent leaves a deferred
-- foreign-key violation that cannot be repaired by renaming its replacement.
CREATE TABLE callback_receipts_replacement AS SELECT * FROM callback_receipts;
DROP TABLE callback_receipts;
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

CREATE TABLE callback_receipts (
 callback_id TEXT PRIMARY KEY,
 attempt_id TEXT NOT NULL UNIQUE,
 outcome TEXT NOT NULL CHECK(outcome IN ('succeeded','failed')),
 result_json TEXT NOT NULL,
 notification_delivered INTEGER NOT NULL DEFAULT 0 CHECK(notification_delivered IN (0,1)),
 created_at INTEGER NOT NULL,
 delivered_at INTEGER,
 FOREIGN KEY(attempt_id) REFERENCES step_attempts(attempt_id)
);
INSERT INTO callback_receipts(callback_id,attempt_id,outcome,result_json,notification_delivered,created_at,delivered_at)
 SELECT callback_id,attempt_id,outcome,result_json,notification_delivered,created_at,delivered_at
 FROM callback_receipts_replacement;
DROP TABLE callback_receipts_replacement;
CREATE INDEX callback_receipts_unnotified ON callback_receipts(notification_delivered,created_at);
