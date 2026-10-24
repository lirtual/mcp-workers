-- Retain the signed temporary Quick Tunnel address on the existing session record.
-- This address is a connection hint, not proof of authenticated reachability.
ALTER TABLE session_executions ADD COLUMN session_url TEXT;
