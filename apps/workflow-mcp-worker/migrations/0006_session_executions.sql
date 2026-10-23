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

-- A cancellation HTTP acknowledgement is never physical termination.
-- One durable record per logical Action Attempt fences repeated calls after
-- network ambiguity, even when the Workflow parent already completed.
CREATE TABLE github_action_cancellations (
  attempt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  cancel_requested_at INTEGER NOT NULL,
  cancel_ack TEXT NOT NULL DEFAULT 'unknown' CHECK(cancel_ack IN ('unknown','accepted')),
  force_requested_at INTEGER,
  force_ack TEXT CHECK(force_ack IN ('unknown','accepted')),
  FOREIGN KEY(attempt_id) REFERENCES step_attempts(attempt_id),
  FOREIGN KEY(run_id) REFERENCES runs(id),
  UNIQUE(run_id,step_id),
  CHECK(force_requested_at IS NULL OR force_requested_at >= cancel_requested_at),
  CHECK(force_requested_at IS NOT NULL OR force_ack IS NULL)
);
