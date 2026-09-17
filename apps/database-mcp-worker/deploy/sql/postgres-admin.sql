-- TEMPLATE ONLY. Replace placeholders after reviewing ownership and schema boundaries.
-- Run as a privileged PostgreSQL administrator. Never use a superuser/application-owner credential directly from MCP.

CREATE ROLE mcp_admin LOGIN PASSWORD '<STRONG_RANDOM_PASSWORD>';
ALTER ROLE mcp_admin NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE mcp_admin SET statement_timeout = '15s';

GRANT CONNECT ON DATABASE <database_name> TO mcp_admin;

-- PostgreSQL ALTER/DROP operations are ownership-based, not granted by a generic ALTER privilege.
-- Recommended: give mcp_admin ownership only of a dedicated schema that this MCP is allowed to manage.
CREATE SCHEMA <admin_schema> AUTHORIZATION mcp_admin;
GRANT USAGE, CREATE ON SCHEMA <admin_schema> TO mcp_admin;

-- If v0.3 must manage existing tables instead, transfer ownership only for explicitly approved
-- objects (or use a separately reviewed owner role). Do NOT make mcp_admin database owner.
-- ALTER TABLE <schema_name>.<table_name> OWNER TO mcp_admin;

-- Keep unrelated schemas unavailable for DDL.
-- REVOKE CREATE ON SCHEMA public FROM mcp_admin;

-- Do NOT grant SUPERUSER, CREATEDB, CREATEROLE, REPLICATION, BYPASSRLS,
-- broad routine EXECUTE, role membership with stronger privileges, or database ownership.
-- Safe Admin v0.3 does not expose GRANT/REVOKE, user/role administration, routines,
-- triggers, replication, backup, server configuration, or arbitrary SQL.

-- Verify before using the credential:
-- \du mcp_admin
-- \dn+ <admin_schema>
