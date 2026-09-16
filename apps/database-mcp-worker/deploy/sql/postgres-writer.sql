-- TEMPLATE ONLY. Replace placeholders after reviewing your schema, RLS policies, and ownership model.
-- Run as a privileged PostgreSQL administrator. Keep this role separate from mcp_reader and application owner roles.

CREATE ROLE mcp_writer LOGIN PASSWORD '<STRONG_RANDOM_PASSWORD>';
ALTER ROLE mcp_writer SET statement_timeout = '15s';

GRANT CONNECT ON DATABASE <database_name> TO mcp_writer;
GRANT USAGE ON SCHEMA <schema_name> TO mcp_writer;
REVOKE CREATE ON SCHEMA <schema_name> FROM mcp_writer;

-- Grant only the tables the MCP writer is allowed to mutate.
-- SELECT may be required for predicates, RLS evaluation, or verification, but read MCP tools never use this role.
GRANT SELECT, INSERT, UPDATE, DELETE ON <schema_name>.<table_name> TO mcp_writer;

-- If generated/default values require a sequence, grant only the specific sequence needed.
-- GRANT USAGE, SELECT ON SEQUENCE <schema_name>.<sequence_name> TO mcp_writer;

-- RLS remains authoritative. mcp_writer must NOT be a superuser and must NOT have BYPASSRLS.
-- Define INSERT/UPDATE/DELETE policies for exactly the rows this role may mutate.

-- PostgreSQL functions may have PUBLIC EXECUTE by default. Revoke side-effecting or SECURITY DEFINER functions.
-- REVOKE EXECUTE ON FUNCTION <schema_name>.<function_signature> FROM PUBLIC, mcp_writer;

-- Do NOT grant CREATE/ALTER/DROP/TRUNCATE, role administration, GRANT OPTION, or broad routine execution.
