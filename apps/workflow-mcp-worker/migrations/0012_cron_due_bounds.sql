CREATE INDEX IF NOT EXISTS cron_due_order_idx ON cron_due(scheduled_ms, workflow_id);
CREATE INDEX IF NOT EXISTS runs_cancel_reconcile_idx ON runs(cancel_requested_at, id)
  WHERE cancel_requested_at IS NOT NULL;
