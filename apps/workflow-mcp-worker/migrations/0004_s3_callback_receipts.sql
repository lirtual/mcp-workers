-- S3 callback inbox: one immutable terminal callback fact per logical Attempt.
-- Durable result is persisted before any Cloudflare Workflow notification.
-- A notification may be delivered repeatedly; the Workflow must reconcile from
-- this table instead of trusting the event alone.
CREATE TABLE IF NOT EXISTS callback_receipts (
 callback_id TEXT PRIMARY KEY,
 attempt_id TEXT NOT NULL UNIQUE,
 outcome TEXT NOT NULL CHECK(outcome IN ('succeeded','failed')),
 result_json TEXT NOT NULL,
 notification_delivered INTEGER NOT NULL DEFAULT 0
   CHECK(notification_delivered IN (0,1)),
 created_at INTEGER NOT NULL,
 delivered_at INTEGER,
 FOREIGN KEY(attempt_id) REFERENCES step_attempts(attempt_id)
);
CREATE INDEX IF NOT EXISTS callback_receipts_unnotified
 ON callback_receipts(notification_delivered,created_at);
