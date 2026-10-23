-- A platform minute that was observed but could not take an advancing slot.
-- The next scheduled tick admits this same minute. A minute Cloudflare never
-- delivered is not inserted here, and this is not a second scheduler.
CREATE TABLE IF NOT EXISTS cron_due (
  workflow_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  scheduled_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workflow_id, event_id),
  FOREIGN KEY(workflow_id) REFERENCES workflows(id)
);
