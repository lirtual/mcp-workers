-- One immutable logical signal per Run/Step, persisted before native sendEvent.
-- An uncertain send can be retried with the same identity and payload.
CREATE TABLE wait_event_receipts (
 run_id TEXT NOT NULL,
 step_id TEXT NOT NULL,
 event_id TEXT NOT NULL,
 payload_digest TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 last_sent_at INTEGER,
 PRIMARY KEY(run_id,step_id),
 FOREIGN KEY(run_id) REFERENCES runs(id)
);
