-- Awaited child Run reservation, single reviewed awaited child; deploy with the selected Workflow Worker.
-- Current ordinary Runs remain weight=1. Future parent admission reserves
-- weight=2, then transfers one unit atomically into a single child Run.
ALTER TABLE runs ADD COLUMN capacity_weight INTEGER NOT NULL DEFAULT 1
  CHECK(capacity_weight IN (1, 2));
ALTER TABLE runs ADD COLUMN parent_run_id TEXT REFERENCES runs(id);
ALTER TABLE runs ADD COLUMN parent_step_id TEXT;
CREATE UNIQUE INDEX runs_one_awaited_child_per_step
  ON runs(parent_run_id, parent_step_id)
  WHERE parent_run_id IS NOT NULL;

-- Durable one-shot cancellation request, separate from normal Step outcome.
-- No second terminate() after a lost Cloudflare response.
CREATE TABLE child_cancellations (
 parent_run_id TEXT NOT NULL,
 parent_step_id TEXT NOT NULL,
 child_run_id TEXT NOT NULL UNIQUE,
 requested_at INTEGER NOT NULL,
 -- Only the caller that claims this field may POST native terminate().
 -- Null keeps a cancellation intent pending during native create/ACK loss.
 termination_attempted_at INTEGER,
 PRIMARY KEY(parent_run_id,parent_step_id),
 FOREIGN KEY(parent_run_id) REFERENCES runs(id),
 FOREIGN KEY(child_run_id) REFERENCES runs(id)
);
