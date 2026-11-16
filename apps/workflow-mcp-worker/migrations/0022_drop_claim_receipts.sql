-- Spec #87: the only persisted copy of a sealed bearer claim; ordinary callback and Run results carry references.
CREATE TABLE drop_claim_receipts (
 attempt_id TEXT PRIMARY KEY REFERENCES step_attempts(attempt_id) ON DELETE CASCADE,
 sealed_claim TEXT NOT NULL,
 preview_url TEXT NOT NULL,
 expires_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE INDEX drop_claim_receipts_expiry ON drop_claim_receipts(expires_at);
