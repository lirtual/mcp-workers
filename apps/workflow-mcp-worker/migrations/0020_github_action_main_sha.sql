-- One per-Attempt frozen SHA for the five owner-approved moving-main Actions.
-- NULL retains identical behavior for every previously pinned historical Attempt.
ALTER TABLE step_attempts ADD COLUMN resolved_sha TEXT
  CHECK(resolved_sha IS NULL OR length(resolved_sha)=40);
