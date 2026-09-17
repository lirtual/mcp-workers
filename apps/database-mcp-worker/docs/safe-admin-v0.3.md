# Safe Admin / DDL v0.3

`database-mcp-worker` v0.3 adds an optional structured schema-management capability while preserving strict READ / WRITE / ADMIN credential separation.

## Capability boundary

Safe Admin exposes only:

- `create_table`
- `alter_table` (add/drop/rename column, rename table)
- `create_index`
- `drop_index`
- `drop_table`

No arbitrary SQL or raw DDL is accepted. The Worker validates identifiers, column definitions, type/options, and supported operation shapes before generating dialect-specific DDL.

## Destructive confirmation

The following operations require explicit `confirm=true` in the MCP request before database execution:

- `drop_table`
- `drop_index`
- `alter_table` with `drop_column`

The Worker does not automatically retry destructive schema operations after an ambiguous execution result.

## Credential isolation

Each logical connection may independently configure:

- `read`
- `write`
- `admin`

Missing `admin` fails closed with `ADMIN_NOT_CONFIGURED`. No credential or transport fallback occurs between READ, WRITE, and ADMIN.

## Admin transport in v0.3

Safe Admin execution is **direct-only in v0.3**. The real PostgreSQL 17 and MySQL 8.4 integration suite verifies the supported DDL lifecycle over dedicated direct ADMIN credentials.

A Hyperdrive ADMIN reference is recognized by configuration parsing so the configuration model does not need another migration later, but execution currently fails closed with `ADMIN_OPERATION_NOT_SUPPORTED`. Hyperdrive Admin must not be enabled until representative DDL behavior is verified against the deployed Hyperdrive/database combination. There is no automatic fallback from Hyperdrive to direct.

## Database privilege guidance

Use the templates in `deploy/sql/` as a starting point:

- `postgres-admin.sql`
- `mysql-admin.sql`

PostgreSQL DDL is ownership-based. Prefer a dedicated managed schema owned by the non-superuser `mcp_admin` role, or explicitly transfer ownership only for approved managed objects.

MySQL 8.4 requires `CREATE` and `INSERT` in addition to `ALTER` for `ALTER TABLE`; table rename also requires `ALTER`/`DROP` on the old table and `CREATE`/`INSERT` on the new table. Scope the MySQL ADMIN account to the approved application database and do not grant server-administration privileges.

## Explicitly excluded

v0.3 does not expose:

- `execute_sql` / arbitrary DDL
- GRANT / REVOKE
- user / role management
- database creation/deletion
- stored procedures/functions
- triggers/events
- replication/backup/server configuration
- migration-history framework
- caller-managed transactions or sessions
