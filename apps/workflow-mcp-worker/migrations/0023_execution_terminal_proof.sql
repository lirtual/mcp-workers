-- #1046: independent, bounded facts that may disappear from native history.
-- Never change the business outcome or repurpose native_complete_seen_at.
ALTER TABLE runs ADD COLUMN execution_terminal_proof TEXT
 CHECK(execution_terminal_proof IS NULL OR
  (length(CAST(execution_terminal_proof AS BLOB))<=4096 AND json_valid(execution_terminal_proof)));
