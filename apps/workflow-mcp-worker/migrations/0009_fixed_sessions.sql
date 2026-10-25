-- Exclusive per-Action fixed Session ownership until verified physical termination.
-- Temporary Sessions have NULL keys and can share four global slots.
ALTER TABLE session_executions ADD COLUMN fixed_key TEXT;
CREATE UNIQUE INDEX session_active_fixed_keys ON session_executions(fixed_key)
  WHERE fixed_key IS NOT NULL AND state != 'terminated';
