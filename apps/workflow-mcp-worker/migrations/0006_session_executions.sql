-- Four concurrent GitHub-hosted Sessions share slots across Action types.
-- The parent Workflow may finish after "ready", so physical Session life
-- must be recorded independently of runs.outcome.
CREATE TABLE session_executions (
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 4),
  state TEXT NOT NULL CHECK(state IN ('queued','starting','ready','stopping','uncertain','terminated')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(run_id,step_id),
  FOREIGN KEY(run_id) REFERENCES runs(id)
);
-- Historical terminated Sessions retain their rows but never occupy quota.
-- The partial unique index prevents an oversubscribed slot even across
-- simultaneous D1 writers.
CREATE UNIQUE INDEX session_active_slots ON session_executions(slot)
  WHERE state != 'terminated';
CREATE INDEX session_by_state ON session_executions(state,updated_at);
