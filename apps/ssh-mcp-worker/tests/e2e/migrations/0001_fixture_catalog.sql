CREATE TABLE workspace_state (id INTEGER PRIMARY KEY, account_id TEXT NOT NULL);
CREATE TABLE hosts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  encrypted_payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
