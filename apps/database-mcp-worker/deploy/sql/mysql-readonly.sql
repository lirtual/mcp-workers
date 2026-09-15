-- TEMPLATE ONLY. Replace placeholders after reviewing your schema.
-- Run as a privileged MySQL administrator. Use TLS-capable authentication compatible with Hyperdrive.

CREATE USER 'mcp_reader'@'%' IDENTIFIED BY '<STRONG_RANDOM_PASSWORD>';
GRANT SELECT ON <database_name>.* TO 'mcp_reader'@'%';

-- Do NOT grant INSERT/UPDATE/DELETE/CREATE/ALTER/DROP/FILE/EXECUTE/LOCK TABLES/GRANT OPTION.
-- Prefer restricted views or column-level SELECT grants when sensitive columns must be hidden.

SHOW GRANTS FOR 'mcp_reader'@'%';
