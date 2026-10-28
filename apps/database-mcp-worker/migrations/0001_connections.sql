-- Spec #344: one atomic, authoritative D1 connection registry.
CREATE TABLE IF NOT EXISTS database_connections (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 1 AND 64),
  dialect TEXT NOT NULL CHECK(dialect IN ('mysql','postgres')),
  status TEXT NOT NULL DEFAULT 'disabled' CHECK(status IN ('active','disabled')),
  ciphertext TEXT NOT NULL,
  key_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
