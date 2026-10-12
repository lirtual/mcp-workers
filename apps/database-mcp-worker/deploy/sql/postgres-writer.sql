-- TEMPLATE ONLY. Replace placeholders after reviewing your schema, RLS policies, and ownership model.
-- Run as a privileged PostgreSQL administrator. Never use the application owner/admin role for MCP Safe Write.

CREATE ROLE mcp_writer LOGIN PASSWORD '<STRONG_RANDOM_PASSWORD>';
ALTER ROLE mcp_writer NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE mcp_writer SET statement_timeout = '15s';

GRANT CONNECT ON DATABASE <database_name> TO mcp_writer;
GRANT USAGE ON SCHEMA <schema_name> TO mcp_writer;
REVOKE CREATE ON SCHEMA <schema_name> FROM mcp_writer;

-- Grant Safe Write privileges only on explicitly approved application tables.
-- Repeat this statement for each table the MCP writer may mutate.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE <schema_name>.<table_name>
  TO mcp_writer;

-- Prefer narrower column-level grants when the writer does not need every column.
-- Example:
-- GRANT SELECT (id, tenant_id), INSERT (tenant_id, value), UPDATE (value)
--   ON TABLE <schema_name>.<table_name> TO mcp_writer;

-- If INSERT relies on an explicit PostgreSQL sequence, grant only that sequence.
-- Identity/sequence requirements vary by schema; do not grant all sequences by default.
-- GRANT USAGE, SELECT ON SEQUENCE <schema_name>.<sequence_name> TO mcp_writer;

-- RLS remains authoritative. Define explicit SELECT/INSERT/UPDATE/DELETE policies for
-- mcp_writer where tenant/data isolation is required. Never grant BYPASSRLS.

-- Do NOT grant CREATE on schemas, table ownership, database ownership, CREATE DATABASE,
-- CREATE ROLE, SUPERUSER, REPLICATION, BYPASSRLS, or broad routine execution.
-- PostgreSQL functions may have PUBLIC EXECUTE by default. Review side-effecting or
-- SECURITY DEFINER functions and revoke PUBLIC execution where appropriate, e.g.:
-- REVOKE EXECUTE ON FUNCTION <schema_name>.<function_signature> FROM PUBLIC;

-- Verify the effective role attributes and grants before using this credential.
-- \du mcp_writer
-- \dp <schema_name>.<table_name>
