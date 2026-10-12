# Cloudflare Database MCP Worker

A Cloudflare-native MCP server for bounded PostgreSQL/MySQL reads, optional structured Safe Write, and optional structured Safe Admin/DDL. READ, WRITE, and ADMIN credentials are configured independently. Direct database URLs remain a legacy plaintext compatibility path; Cloudflare Hyperdrive is supported for READ/WRITE TLS-capable database paths.

## Minimal deployment

The normal deployment requires only two Runtime Secrets:

- `MCP_ACCESS_TOKEN` — authenticates Cloudflare MCP Portal -> Worker.
- `DATABASE_CONFIG` — contains the complete logical database catalog, including direct database credentials when direct mode is used.

Do not put either value in Cloudflare Build variables/secrets. Store both under **Worker Settings -> Variables and Secrets** as **Secret** values.

### One read-only database

```json
{
  "main": {
    "read": "mysql://reader:password@db.example.com:3306/app"
  }
}
```

The object key is the MCP connection id, so no duplicate `id` field is needed. `displayName` defaults to the same value and `enabled` defaults to `true`.

### MySQL server-level connection

MySQL may omit the database name when one account needs to access multiple databases on the same server:

```json
{
  "mysql_server": {
    "read": "mysql://reader:password@db.example.com:3306"
  }
}
```

For a server-level MySQL connection:

- `health_check` works without a default database.
- `inspect_schema` with no `schema` lists databases visible to the MySQL account.
- `inspect_schema` with `schema` inspects that database.
- `get_schema_context` requires `schema` unless `defaultSchema` is configured.
- `query_read` / `explain` should use fully qualified names such as `app.users` when the SQL needs a table.
- Safe Write and Safe Admin require an explicit `schema` unless `defaultSchema` is configured.
- The effective database access boundary is the MySQL account's grants.

PostgreSQL direct URLs still require a database name.

### Read + Safe Write + Safe Admin

```json
{
  "main": {
    "displayName": "Main Database",
    "read": "mysql://mcp_reader:password@db.example.com:3306/app",
    "write": "mysql://mcp_writer:password@db.example.com:3306/app",
    "admin": "mysql://mcp_admin:password@db.example.com:3306/app",
    "maxAffectedRows": 20
  }
}
```

`write` and `admin` are optional and independent:

- missing `write` -> Safe Write tools fail closed with `WRITE_NOT_CONFIGURED`;
- missing `admin` -> Safe Admin tools fail closed with `ADMIN_NOT_CONFIGURED`;
- READ never falls back to WRITE/ADMIN;
- WRITE never falls back to READ/ADMIN;
- ADMIN never falls back to READ/WRITE.

Deployment templates are provided under `deploy/sql/`:

- `postgres-readonly.sql`
- `postgres-writer.sql`
- `postgres-admin.sql`
- `mysql-readonly.sql`
- `mysql-writer.sql`
- `mysql-admin.sql`

Reader and writer templates remain least-privilege. PostgreSQL Safe Admin is ownership-based, so the recommended pattern is a dedicated schema owned by the non-superuser `mcp_admin` role or explicit ownership only for approved managed objects. MySQL Safe Admin is scoped to an approved database; MySQL 8.4 requires `CREATE` and `INSERT` in addition to `ALTER` for `ALTER TABLE`, and table rename also requires `ALTER`/`DROP` on the old table plus `CREATE`/`INSERT` on the new table. The MCP Admin surface still exposes only structured DDL, never arbitrary DML/admin SQL.

### Multiple databases

```json
{
  "main": {
    "read": "mysql://reader:password@mysql.example.com/app"
  },
  "analytics": {
    "displayName": "Analytics",
    "read": "postgres://reader:password@pg.example.com/analytics"
  }
}
```

`DATABASE_CONFIG` supports 1-50 logical connections.

## Hyperdrive

Hyperdrive references stay explicit because the binding itself is configured in Wrangler/Cloudflare rather than embedded in the Secret.

```json
{
  "production": {
    "read": {
      "hyperdrive": "PROD_READ",
      "dialect": "postgres"
    },
    "write": {
      "hyperdrive": "PROD_WRITE"
    },
    "maxAffectedRows": 20
  }
}
```

Read and write transports may differ. There is no automatic transport fallback.

Safe Admin execution is **direct-only in v0.3** because the repository's real PostgreSQL/MySQL integration verifies DDL only through direct ADMIN credentials. An `admin: { "hyperdrive": "..." }` reference is recognized by the configuration model but execution fails closed with `ADMIN_OPERATION_NOT_SUPPORTED` until representative Hyperdrive DDL behavior is verified. It never falls back to direct.

## Direct mode

Direct mode accepts complete SQL URLs:

- PostgreSQL: `postgres://` or `postgresql://` (database name required)
- MySQL: `mysql://` (database name optional)

Dialect is derived from the URL automatically. Direct URLs requesting TLS are rejected; use Hyperdrive for TLS-capable READ/WRITE database paths.

Direct mode is intentionally a compatibility path for publicly reachable legacy databases where plaintext transport is explicitly acceptable. Workers VPC / Cloudflare Tunnel transport is outside the current contract.

## Optional per-connection settings

Each connection can additionally set:

- `displayName`
- `enabled`
- `defaultSchema`
- `maxRows`
- `maxResultBytes`
- `maxSchemaBytes`
- `queryTimeoutMs`
- `maxAffectedRows` (only when `write` is configured)
- `write`
- `admin`

Global deployment limits remain controlled by Wrangler vars:

- `MAX_ROWS=500`
- `MAX_RESULT_BYTES=1048576`
- `MAX_SCHEMA_BYTES=524288`
- `QUERY_TIMEOUT_MS=15000`
- `MAX_WRITE_AFFECTED_ROWS=20` (hard maximum 100)

Per-connection limits may be stricter but cannot raise the global deployment maximum.

## MCP tools

Read tools:

- `list_connections`
- `inspect_schema`
- `get_schema_context`
- `query_read`
- `explain`
- `health_check`

`get_schema_context` is optimized for Agent/LLM planning rather than exhaustive metadata. It returns a compact text representation of up to 50 tables by default (`tableLimit` accepts 1-100), including columns, nullability, primary keys, and foreign-key relationships. It reports `tableCount`, `totalTables`, and `truncated` so callers know when the context is incomplete. Use `inspect_schema` when detailed defaults or indexes are needed.

Safe Write tools:

- `insert_rows`
- `update_rows`
- `delete_rows`

Safe Admin/DDL tools:

- `create_table`
- `alter_table` — add column, drop column, rename column, rename table
- `create_index`
- `drop_index`
- `drop_table`

`query_read` remains read-only. Safe Write tools never accept raw write SQL. Safe Admin tools never accept raw DDL or arbitrary type/default expressions.

## Safe Write guarantees

- `insert_rows`: 1-100 rows per invocation.
- `update_rows` / `delete_rows`: require a non-empty structured predicate.
- UPDATE/DELETE run in an explicit transaction.
- If affected rows exceed the configured maximum, the transaction is rolled back with `WRITE_LIMIT_EXCEEDED`.
- PostgreSQL RLS and database-native permissions remain authoritative.
- MySQL rollback guarantees require transactional engines such as InnoDB.

## Safe Admin guarantees

- ADMIN credentials are separate from READ and WRITE credentials.
- `create_table` accepts only a bounded scalar type subset and literal defaults.
- `alter_table` supports only add/drop/rename column and rename table in v0.3.
- `create_index` supports ordinary column indexes only; expression/partial/fulltext/spatial/vendor-specific advanced indexes are excluded.
- `drop_table`, `drop_index`, and `alter_table` drop-column use MCP 2026-era `input_required` form elicitation. The destructive DDL runs only after the client returns an accepted user confirmation with the checkbox selected; decline/cancel/unconfirmed or unsupported confirmation flows fail closed.
- destructive Admin operations are not automatically retried after an ambiguous result.
- v0.3 Safe Admin is direct-only; unverified Hyperdrive Admin fails closed.
- no `execute_sql`, raw DDL, GRANT/REVOKE, user/role management, routine, trigger, replication, backup, or server-configuration tool is exposed.
- database-native privileges remain the final boundary even when the MCP input is structurally valid.

Supported column types in the initial v0.3 subset:

- integer / bigint
- numeric / decimal
- varchar / text
- boolean
- date
- timestamp / datetime
- json

Supported column options are limited to bounded varchar length, numeric precision/scale, nullability, literal defaults, primary key, and unique.

## Portal authentication

Store a dedicated Worker secret:

```bash
pnpm --filter database-mcp-worker exec wrangler secret put MCP_ACCESS_TOKEN
```

Then configure Cloudflare MCP Portal to send the same value as upstream Bearer authentication.

The Worker returns `503 portal_auth_not_configured` when the Portal token is missing and `503 database_config_not_configured` when `DATABASE_CONFIG` is unavailable at runtime.

## Development and verification

```bash
pnpm install --frozen-lockfile
pnpm --filter database-mcp-worker check
```

Monorepo CI runs unit checks plus real PostgreSQL 17 / MySQL 8.4 integration tests with separate reader, writer, bounded admin, and fixture-owner identities. Integration proves READ cannot write/DDL, WRITE cannot DDL, ADMIN can perform the supported schema lifecycle, PostgreSQL ADMIN is not a superuser/role administrator, and MySQL ADMIN cannot create users. Unit coverage verifies the destructive `input_required` confirmation flow and compact schema-context formatting.

## Security notes

- Keep `DATABASE_CONFIG` as a Cloudflare Runtime Secret; never commit its real value.
- Do not log `DATABASE_CONFIG`, SQL URLs, database passwords, MCP bearer tokens, write values, write predicates, or generated admin SQL.
- `list_connections` exposes only non-secret capability metadata (`writeEnabled` / `adminEnabled` and transport names).
- Direct READ/WRITE/ADMIN credentials are never returned in MCP responses.
- Hyperdrive binding internals are never returned in MCP responses.

## License and provenance

MIT license and source provenance are preserved in `LICENSE` and `SOURCE.md`.
