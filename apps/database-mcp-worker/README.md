# Cloudflare Database MCP Worker

A Cloudflare-native MCP server for bounded PostgreSQL/MySQL reads plus optional structured Safe Write. It supports direct database URLs for legacy plaintext connections and Cloudflare Hyperdrive for TLS-capable databases.

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
- `query_read` / `explain` should use fully qualified names such as `app.users` when the SQL needs a table.
- Safe Write requires an explicit `schema` unless `defaultSchema` is configured.
- The effective database access boundary is the MySQL account's grants.

PostgreSQL direct URLs still require a database name.

### Read + Safe Write

```json
{
  "main": {
    "displayName": "Main Database",
    "read": "mysql://mcp_reader:password@db.example.com:3306/app",
    "write": "mysql://mcp_writer:password@db.example.com:3306/app",
    "maxAffectedRows": 20
  }
}
```

`write` is optional. When it is absent, write tools return `WRITE_NOT_CONFIGURED`; the Worker never falls back to the read credential for writes.

Use separate least-privilege reader/writer database identities. Deployment templates are provided under `deploy/sql/`:

- `postgres-readonly.sql`
- `postgres-writer.sql`
- `mysql-readonly.sql`
- `mysql-writer.sql`

The writer templates intentionally grant `SELECT`, `INSERT`, `UPDATE`, and `DELETE` only on explicitly approved tables. Repeat the table grant for each table Safe Write may mutate rather than granting broad database/schema write access by default. PostgreSQL writer roles remain non-superuser/non-owner and must not receive `BYPASSRLS`; MySQL writers must not receive DDL, routine, file, grant-option, or administrative privileges. If PostgreSQL inserts require a sequence, grant only the specific sequence needed.

These deployment templates mirror the least-privilege writer model used by the real PostgreSQL/MySQL integration fixtures, so production setup and CI exercise the same READ/WRITE separation assumptions.

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

## Direct mode

Direct mode accepts complete SQL URLs:

- PostgreSQL: `postgres://` or `postgresql://` (database name required)
- MySQL: `mysql://` (database name optional)

Dialect is derived from the URL automatically. Direct URLs requesting TLS are rejected; use Hyperdrive for TLS-capable databases.

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
- `query_read`
- `explain`
- `health_check`

Safe Write tools:

- `insert_rows`
- `update_rows`
- `delete_rows`

`query_read` remains read-only. Safe Write tools never accept raw write SQL; they generate parameterized statements internally.

## Safe Write guarantees

- `insert_rows`: 1-100 rows per invocation.
- `update_rows` / `delete_rows`: require a non-empty structured predicate.
- UPDATE/DELETE run in an explicit transaction.
- If affected rows exceed the configured maximum, the transaction is rolled back with `WRITE_LIMIT_EXCEEDED`.
- PostgreSQL RLS and database-native permissions remain authoritative.
- MySQL rollback guarantees require transactional engines such as InnoDB.

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

Monorepo CI runs unit checks plus real PostgreSQL 17 / MySQL 8.4 integration tests with separate admin, reader, and writer identities. The integration writer permissions follow the same least-privilege model documented by the deployment templates: approved-table `SELECT`/`INSERT`/`UPDATE`/`DELETE`, no DDL/admin privileges, PostgreSQL RLS preserved, and MySQL transactional tables for rollback safety.

## Security notes

- Keep `DATABASE_CONFIG` as a Cloudflare Runtime Secret; never commit its real value.
- Do not log `DATABASE_CONFIG`, SQL URLs, database passwords, MCP bearer tokens, write values, or write predicates.
- `list_connections` exposes only non-secret metadata.
- Direct read/write credentials are never returned in MCP responses.
- Hyperdrive binding internals are never returned in MCP responses.

## License and provenance

MIT license and source provenance are preserved in `LICENSE` and `SOURCE.md`.
