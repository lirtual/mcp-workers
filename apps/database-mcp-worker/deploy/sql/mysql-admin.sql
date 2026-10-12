-- TEMPLATE ONLY. Replace placeholders after reviewing the database boundary.
-- Run as a privileged MySQL administrator. Never use root/admin credentials directly from MCP.

CREATE USER 'mcp_admin'@'%' IDENTIFIED BY '<STRONG_RANDOM_PASSWORD>';
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'mcp_admin'@'%';

-- Safe Admin v0.3 supports CREATE/ALTER/DROP TABLE plus CREATE/DROP INDEX.
-- MySQL 8.4 requires CREATE + INSERT in addition to ALTER for ALTER TABLE;
-- table rename also requires ALTER/DROP on the old table and CREATE/INSERT on the new table.
-- Therefore INSERT is included even though the MCP Admin tool surface does not expose row inserts.
GRANT CREATE, ALTER, DROP, INDEX, INSERT
  ON <database_name>.*
  TO 'mcp_admin'@'%';

-- Scope this account to one explicitly approved application database whenever possible.
-- Do NOT grant CREATE USER, CREATE ROLE, DROP ROLE, FILE, EXECUTE, PROCESS,
-- RELOAD, REPLICATION privileges, SUPER-style dynamic privileges, or GRANT OPTION.
-- Do not grant privileges on mysql.*, information_schema.*, performance_schema.*, or sys.*.

SHOW GRANTS FOR 'mcp_admin'@'%';
