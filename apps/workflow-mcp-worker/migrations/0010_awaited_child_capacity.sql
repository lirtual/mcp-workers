-- Awaited child Run reservation, not yet an executable flow.child capability.
-- Current ordinary Runs remain weight=1. Future parent admission reserves
-- weight=2, then transfers one unit atomically into a single child Run.
ALTER TABLE runs ADD COLUMN capacity_weight INTEGER NOT NULL DEFAULT 1
  CHECK(capacity_weight IN (1, 2));
ALTER TABLE runs ADD COLUMN parent_run_id TEXT REFERENCES runs(id);
ALTER TABLE runs ADD COLUMN parent_step_id TEXT;
CREATE UNIQUE INDEX runs_one_awaited_child_per_step
  ON runs(parent_run_id, parent_step_id)
  WHERE parent_run_id IS NOT NULL;
