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

-- Old Worker versions still use COUNT(*) during an in-flight code/schema
-- cutover. Count-based ingress can admit an extra Run while a new parent
-- occupies two units; preserve the eight-unit limit at the D1 boundary.
-- Child INSERTs are exempt because their already-reserved parent atomically
-- transfers one unit (weight 2 -> 1) in the same D1 batch.
CREATE TRIGGER runs_top_level_capacity_guard
BEFORE INSERT ON runs
WHEN NEW.parent_run_id IS NULL AND NEW.outcome IN ('queued','running')
 AND (SELECT COALESCE(SUM(capacity_weight),0) FROM runs
      WHERE outcome IN ('queued','running')) + NEW.capacity_weight > 8
BEGIN
 SELECT RAISE(IGNORE);
END;
