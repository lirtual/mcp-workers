-- TEMPLATE ONLY. Replace placeholders after reviewing your schema.
-- Run as a privileged MySQL administrator. Keep this role separate from mcp_reader and application owner users.

CREATE USER 'mcp_writer'@'%' IDENTIFIED BY '<STRONG_RANDOM_PASSWORD>';

-- Grant only the tables the MCP writer is allowed to mutate.
-- SELECT may be required for predicates or verification, but read MCP tools never use this account.
GRANT SELECT, INSERT, UPDATE, DELETE ON <database_name>.<table_name> TO 'mcp_writer'@'%';

-- Safe Write rollback protection requires transactional tables such as InnoDB.
-- Non-transactional tables are outside the v0.2 safety guarantee.

-- Do NOT grant CREATE/ALTER/DROP/TRUNCATE/FILE/EXECUTE/LOCK TABLES/PROCESS/GRANT OPTION or administrative privileges.

SHOW GRANTS FOR 'mcp_writer'@'%';
