-- Preserve immutable Workflow Versions, Runs and receipts after owner deletion.
ALTER TABLE workflows ADD COLUMN deleted_at INTEGER;
