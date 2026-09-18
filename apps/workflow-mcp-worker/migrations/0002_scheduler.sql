CREATE TABLE IF NOT EXISTS scheduler_state (
  schedule_key TEXT PRIMARY KEY,
  last_evaluated_at INTEGER NOT NULL,
  last_admitted_scheduled_time INTEGER,
  next_due_occurrence INTEGER
);
