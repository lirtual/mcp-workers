-- TEMPLATE ONLY. Replace placeholders after reviewing your database and table boundaries.
-- Run as a privileged MySQL administrator. Never use root/admin credentials for MCP Safe Write.

CREATE USER 'mcp_writer'@'%' IDENTIFIED BY '<STRONG_RANDOM_PASSWORD>';

-- Start from no privileges so an existing/reused role cannot retain broader access.
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'mcp_writer'@'%';

-- Grant Safe Write privileges only on explicitly approved application tables.
-- Repeat this statement for each table the MCP writer may mutate.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON <database_name>.<table_name>
  TO 'mcp_writer'@'%';

-- Prefer column-level grants when the writer does not need every column.
-- Example:
-- GRANT SELECT (id, tenant_id), INSERT (tenant_id, value), UPDATE (value)
--   ON <database_name>.<table_name> TO 'mcp_writer'@'%';

-- Safe Write rollback guarantees require transactional tables such as InnoDB.
-- Do not rely on the affected-row rollback guard for non-transactional engines.

-- Do NOT grant CREATE, ALTER, DROP, INDEX, CREATE USER, FILE, EXECUTE,
-- LOCK TABLES, PROCESS, SUPER-style administrative privileges, or GRANT OPTION.
-- Do not grant database-wide <database_name>.* access unless that breadth is explicitly required.

SHOW GRANTS FOR 'mcp_writer'@'%';
