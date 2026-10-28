-- Additive Spec #344 evolution. 0001 is already deployed: do not alter it.
-- D1 applies migrations atomically. Copy original encrypted Direct credentials.
CREATE TABLE database_connections_next (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 1 AND 64),
  dialect TEXT NOT NULL CHECK(dialect IN ('mysql','postgres')),
  transport TEXT NOT NULL CHECK(transport IN ('direct','hyperdrive')),
  status TEXT NOT NULL DEFAULT 'disabled' CHECK(status IN ('active','disabled')),
  ciphertext TEXT,
  key_id TEXT,
  config_id TEXT,
  binding_name TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK(
    (transport='direct' AND ciphertext IS NOT NULL AND key_id IS NOT NULL
      AND config_id IS NULL AND binding_name IS NULL)
    OR
    (transport='hyperdrive' AND ciphertext IS NULL AND key_id IS NULL
      AND config_id IS NOT NULL AND binding_name IS NOT NULL)
  )
);
INSERT INTO database_connections_next (
  id,dialect,transport,status,ciphertext,key_id,revision,created_at,updated_at
) SELECT id,dialect,'direct','disabled',ciphertext,key_id,revision+1,created_at,updated_at
  FROM database_connections;
DROP TABLE database_connections;
ALTER TABLE database_connections_next RENAME TO database_connections;
CREATE UNIQUE INDEX database_hyperdrive_config_unique
  ON database_connections(config_id) WHERE config_id IS NOT NULL;
CREATE UNIQUE INDEX database_hyperdrive_binding_unique
  ON database_connections(binding_name) WHERE binding_name IS NOT NULL;
CREATE TABLE retired_connection_ids (
  id TEXT PRIMARY KEY NOT NULL,
  retired_at INTEGER NOT NULL
);
-- Retire in the same SQLite statement/transaction as DELETE, including CAS failures.
CREATE TRIGGER database_connections_retire_id
AFTER DELETE ON database_connections
BEGIN
  INSERT INTO retired_connection_ids(id,retired_at) VALUES (OLD.id,CAST(strftime('%s','now') AS INTEGER));
END;
