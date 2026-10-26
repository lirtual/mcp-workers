CREATE TABLE IF NOT EXISTS mail_accounts (
  account_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider = 'imap_smtp'),
  address TEXT NOT NULL,
  alias TEXT,
  status TEXT NOT NULL CHECK (status IN ('active','reauthorization_required','disabled')),
  credential_ciphertext TEXT NOT NULL,
  credential_key_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS send_attempts (
  account_id TEXT NOT NULL REFERENCES mail_accounts(account_id),
  request_id TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('indeterminate','submitted','accepted','failed')),
  reference TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, request_id)
);
CREATE INDEX IF NOT EXISTS idx_send_expiry ON send_attempts(expires_at);
