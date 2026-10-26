-- Per physical Session/Attempt/key, encrypted at rest; the last sequence
-- survives TTL expiration to fence delayed or reordered Runner observations.
CREATE TABLE session_runtime_data (
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  key TEXT NOT NULL CHECK(key='uu.credentials'),
  attempt_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  status TEXT NOT NULL CHECK(status IN ('ready','unavailable')),
  ciphertext TEXT,
  iv TEXT,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(run_id,step_id,key),
  FOREIGN KEY(run_id,step_id) REFERENCES session_executions(run_id,step_id),
  FOREIGN KEY(attempt_id) REFERENCES step_attempts(attempt_id),
  CHECK((status='ready' AND ciphertext IS NOT NULL AND iv IS NOT NULL)
    OR (status='unavailable' AND ciphertext IS NULL AND iv IS NULL))
);
