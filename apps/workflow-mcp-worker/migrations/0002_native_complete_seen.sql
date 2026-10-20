-- Track the first observed native-complete state, not the Run creation time.
-- Long-running Workflows must never be expired immediately after completing.
ALTER TABLE runs ADD COLUMN native_complete_seen_at INTEGER;
