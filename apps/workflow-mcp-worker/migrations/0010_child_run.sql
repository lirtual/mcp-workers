-- A child Run is a normal D1 Run row and Cloudflare Workflow instance.
-- call_depth bounds recursion. Waiting parents are not advancing admissions.
ALTER TABLE runs ADD COLUMN parent_run_id TEXT;
ALTER TABLE runs ADD COLUMN parent_step_id TEXT;
ALTER TABLE runs ADD COLUMN child_mode TEXT;
ALTER TABLE runs ADD COLUMN call_depth INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS runs_by_parent ON runs(parent_run_id, child_mode);
-- Dispatch and reconcile already return the GitHub run head. Keep that sha
-- on the Attempt the status read shows. No extra GitHub call.
ALTER TABLE step_attempts ADD COLUMN head_sha TEXT;
