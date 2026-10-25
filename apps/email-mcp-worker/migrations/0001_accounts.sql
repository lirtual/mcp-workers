CREATE TABLE IF NOT EXISTS mail_accounts (
  account_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('gmail','graph','imap_smtp')),
  address TEXT NOT NULL,
  alias TEXT,
  status TEXT NOT NULL CHECK (status IN ('active','reauthorization_required','disabled')),
  credential_ciphertext TEXT NOT NULL,
  credential_key_id TEXT NOT NULL,
  token_expires_at INTEGER,
  token_version INTEGER NOT NULL DEFAULT 0,
  refresh_lock_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_sessions (
  state_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('gmail','graph')),
  account_id TEXT,
  owner_sub TEXT NOT NULL,
  pkce_ciphertext TEXT NOT NULL,
  key_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
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
CREATE INDEX IF NOT EXISTS idx_oauth_expiry ON oauth_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_send_expiry ON send_attempts(expires_at);
