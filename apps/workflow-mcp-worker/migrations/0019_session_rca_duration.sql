-- The signed physical Runner's job-scoped effective duration is recorded only
-- by the first Ready CAS. No new authority table, refresh or extension.
ALTER TABLE session_executions ADD COLUMN rca_duration_minutes INTEGER
  CHECK(rca_duration_minutes IS NULL OR rca_duration_minutes BETWEEN 1 AND 300);
