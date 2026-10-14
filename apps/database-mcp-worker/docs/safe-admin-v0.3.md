# Safe Admin / DDL v0.3

`database-mcp-worker` exposes structured schema-management tools using the selected logical connection's single database principal. Database-native grants and object ownership determine whether operations succeed.

## Capability boundary

Safe Admin exposes `create_table`, `alter_table` (add/drop/rename column, rename table), `create_index`, `drop_index`, and `drop_table`. The Worker validates identifiers, column definitions, type/options, and operation shapes before generating dialect-specific DDL. It accepts no arbitrary SQL or raw DDL.

Destructive DDL names its target explicitly and publishes truthful MCP risk annotations. User approval belongs to the MCP client. The Worker does not automatically retry DDL after an ambiguous execution result.

## Connection and transport

`DATABASE_CONFIG` is a flat map from logical connection IDs to SQL URL strings or strict `{ "hyperdrive": "BINDING", "dialect": "mysql|postgres" }` objects. Reads, structured writes, and DDL use the same selected identity. Hyperdrive DDL fails closed with `ADMIN_OPERATION_NOT_SUPPORTED` and never falls back to a direct URL.

## Database privilege guidance

The templates in `deploy/sql/` are optional starting points for separate grant profiles. PostgreSQL DDL requires ownership of managed objects or suitable privileges. MySQL DDL requires the corresponding database/table privileges. The Worker adds no privilege or elevated credential fallback.

## Explicitly excluded

The Worker exposes no arbitrary DDL, GRANT/REVOKE, user/role management, database creation/deletion, routines, triggers/events, replication/backup/server configuration, migration-history framework, or caller-managed transactions/sessions.
