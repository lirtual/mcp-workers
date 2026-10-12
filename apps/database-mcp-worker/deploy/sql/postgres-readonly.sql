-- TEMPLATE ONLY. Replace placeholders after reviewing your schema and ownership model.
-- Run as a privileged PostgreSQL administrator. Never use the application owner role for MCP.

CREATE ROLE mcp_reader LOGIN PASSWORD '<STRONG_RANDOM_PASSWORD>';
ALTER ROLE mcp_reader SET default_transaction_read_only = on;
ALTER ROLE mcp_reader SET statement_timeout = '15s';

GRANT CONNECT ON DATABASE <database_name> TO mcp_reader;
GRANT USAGE ON SCHEMA <schema_name> TO mcp_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA <schema_name> TO mcp_reader;

-- Keep future tables read-only for this role if desired. Review owner identity first.
ALTER DEFAULT PRIVILEGES IN SCHEMA <schema_name>
  GRANT SELECT ON TABLES TO mcp_reader;

-- Do not grant sequence USAGE unless a reviewed read query truly needs it.
-- RLS policies remain authoritative; mcp_reader must NOT have BYPASSRLS.

-- IMPORTANT: PostgreSQL functions may have PUBLIC EXECUTE by default.
-- Revoke side-effecting or SECURITY DEFINER functions explicitly, e.g.:
-- REVOKE EXECUTE ON FUNCTION <schema_name>.<function_signature> FROM PUBLIC, mcp_reader;
