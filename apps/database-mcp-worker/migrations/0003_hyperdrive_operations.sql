-- Spec #476: bounded Owner Hyperdrive operations; never store origin secrets in cleartext.
-- Applied migrations are immutable. This is additive to Spec #344.
CREATE TABLE hyperdrive_operations (
  operation_id TEXT PRIMARY KEY NOT NULL,
  logical_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('create','rotate_credentials','rotate_ca','retire')),
  expected_revision INTEGER NOT NULL CHECK(expected_revision >= 0),
  expected_source_sha TEXT,
  phase TEXT NOT NULL CHECK(phase IN ('pending','running','awaiting_confirmation','completed','failed','unknown')),
  ciphertext TEXT,
  key_id TEXT,
  config_id TEXT,
  binding_name TEXT,
  pr_number INTEGER,
  head_sha TEXT,
  merged_sha TEXT,
  ci_run_id INTEGER,
  release_run_id INTEGER,
  prepare_run_id INTEGER,
  apply_run_id INTEGER,
  published_version_id TEXT,
  verified_metadata TEXT,
  verified_at INTEGER,
  error_class TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  resource_write_started_at INTEGER,
  ca_write_started_at INTEGER,
  ca_certificate_id TEXT,
  CHECK ((ciphertext IS NULL AND key_id IS NULL) OR (ciphertext IS NOT NULL AND key_id IS NOT NULL))
);
-- Pending/unknown operations exclude other changes to the same immutable ID,
-- including a second preview confirmation and a concurrent delete.
CREATE UNIQUE INDEX hyperdrive_one_unresolved_operation
  ON hyperdrive_operations(logical_id)
  WHERE phase IN ('pending','running','awaiting_confirmation','unknown');
CREATE INDEX hyperdrive_operation_recent
  ON hyperdrive_operations(updated_at DESC);

-- Enforce the reservation at the database boundary, including direct Runner SQL.
CREATE TRIGGER hyperdrive_operation_reserves_id
BEFORE INSERT ON hyperdrive_operations WHEN NEW.action='create'
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM database_connections WHERE id=NEW.logical_id)
    OR EXISTS (SELECT 1 FROM retired_connection_ids WHERE id=NEW.logical_id)
    OR (SELECT COUNT(*) FROM database_connections) +
      (SELECT COUNT(*) FROM hyperdrive_operations WHERE action='create'
       AND phase IN ('pending','running','awaiting_confirmation','unknown')) >= 10
    THEN RAISE(ABORT, 'hyperdrive reservation conflict') END;
END;

-- Exact post-publication proof consumes this operation's reservation only.
ALTER TABLE database_connections ADD COLUMN target_metadata TEXT;
CREATE TRIGGER database_connection_respects_reservation
BEFORE INSERT ON database_connections
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM retired_connection_ids WHERE id=NEW.id)
    OR EXISTS (SELECT 1 FROM hyperdrive_operations o WHERE o.logical_id=NEW.id
      AND o.phase IN ('pending','running','awaiting_confirmation','unknown')
      AND NOT (o.action='create' AND o.phase='running' AND o.expected_revision=0
        AND o.error_class='postrelease_verified' AND o.release_run_id>0 AND o.apply_run_id>0
        AND length(o.merged_sha)=40 AND length(o.published_version_id)=36
        AND o.verified_at IS NOT NULL AND o.expires_at>o.verified_at
        AND o.config_id=NEW.config_id AND o.binding_name=NEW.binding_name
        AND o.verified_metadata=NEW.target_metadata
        AND json_extract(o.verified_metadata,'$.dialect')=NEW.dialect
        AND NEW.transport='hyperdrive' AND NEW.status='disabled' AND NEW.revision=1
        AND NEW.ciphertext IS NULL AND NEW.key_id IS NULL
        AND NEW.created_at=o.verified_at AND NEW.updated_at=o.verified_at))
    OR (SELECT COUNT(*) FROM database_connections) +
      (SELECT COUNT(*) FROM hyperdrive_operations o WHERE o.action='create'
       AND o.phase IN ('pending','running','awaiting_confirmation','unknown')
       AND NOT EXISTS (SELECT 1 FROM database_connections c WHERE c.id=o.logical_id)
       AND o.logical_id!=NEW.id) >= 10
    THEN RAISE(ABORT, 'hyperdrive reservation conflict') END;
END;
CREATE TRIGGER database_target_metadata_immutable
BEFORE UPDATE OF target_metadata ON database_connections
WHEN NEW.target_metadata IS NOT OLD.target_metadata
BEGIN
  SELECT RAISE(ABORT, 'immutable target metadata');
END;

-- In-place changes/rebinding must wait until the operation resolves. Disable
-- remains available for safety and changes revision, invalidating the Runner CAS.
CREATE TRIGGER database_connection_preserves_operation
BEFORE UPDATE ON database_connections
WHEN EXISTS (SELECT 1 FROM hyperdrive_operations WHERE logical_id=OLD.id
  AND phase IN ('pending','running','awaiting_confirmation','unknown'))
  AND NOT (NEW.status='disabled' AND NEW.revision=OLD.revision+1
    AND NEW.id=OLD.id AND NEW.dialect=OLD.dialect AND NEW.transport=OLD.transport
    AND NEW.ciphertext IS OLD.ciphertext AND NEW.key_id IS OLD.key_id
    AND NEW.config_id IS OLD.config_id AND NEW.binding_name IS OLD.binding_name)
BEGIN
  SELECT RAISE(ABORT, 'hyperdrive reservation conflict');
END;
CREATE TRIGGER database_connection_preserves_retirement
BEFORE DELETE ON database_connections
WHEN EXISTS (SELECT 1 FROM hyperdrive_operations WHERE logical_id=OLD.id
  AND phase IN ('pending','running','awaiting_confirmation','unknown'))
BEGIN
  SELECT RAISE(ABORT, 'hyperdrive reservation conflict');
END;

-- One durable, conservative execution counter per connection (not a new queue
-- or service). Count is acquired atomically before any Hyperdrive SQL and
-- released only after a confirmed successful completion. Ambiguous/unobserved
-- completions intentionally retain a nonzero counter and block retirement.
-- Migration 0003 is not deployed; never edit it after production application.
ALTER TABLE database_connections ADD COLUMN in_flight_count INTEGER NOT NULL DEFAULT 0
  CHECK(in_flight_count >= 0);

-- Defense in depth: no SQL/DDL path may remove or rebind a still-reserved
-- Hyperdrive reference while any counted execution remains unresolved.
CREATE TRIGGER database_connection_blocks_inflight_delete
BEFORE DELETE ON database_connections
WHEN OLD.in_flight_count > 0
BEGIN SELECT RAISE(ABORT, 'hyperdrive execution still in flight'); END;
CREATE TRIGGER database_connection_blocks_inflight_rebind
BEFORE UPDATE OF config_id,binding_name,transport ON database_connections
WHEN OLD.in_flight_count > 0 AND
 (NEW.config_id IS NOT OLD.config_id OR NEW.binding_name IS NOT OLD.binding_name OR
  NEW.transport IS NOT OLD.transport)
BEGIN SELECT RAISE(ABORT, 'hyperdrive execution still in flight'); END;

-- Until a separately reviewed, version-aware, rollback-safe cutover exists,
-- both Hyperdrive resource references remain immutable even with zero SQL
-- in flight. Otherwise an ad-hoc D1 UPDATE could silently rebind an older
-- Worker version to a config it has never published or verified.
CREATE TRIGGER database_connection_blocks_unreviewed_rebind
BEFORE UPDATE OF config_id,binding_name ON database_connections
WHEN OLD.transport='hyperdrive' AND
  (NEW.config_id IS NOT OLD.config_id OR NEW.binding_name IS NOT OLD.binding_name)
BEGIN SELECT RAISE(ABORT, 'unreviewed Hyperdrive rebind'); END;

-- Logical deletion is independent of physical Cloudflare unbinding or CA cleanup.
-- Retain the immutable resource identity in the existing retired-ID ledger so
-- cleanup provenance survives D1 row removal without creating a new table.
ALTER TABLE retired_connection_ids ADD COLUMN upstream_config_id TEXT;
ALTER TABLE retired_connection_ids ADD COLUMN upstream_binding_name TEXT;
DROP TRIGGER database_connections_retire_id;
CREATE TRIGGER database_connections_retire_id
AFTER DELETE ON database_connections
BEGIN
  INSERT INTO retired_connection_ids
    (id,retired_at,upstream_config_id,upstream_binding_name)
    VALUES (OLD.id,CAST(strftime('%s','now') AS INTEGER),
      OLD.config_id,OLD.binding_name);
END;
