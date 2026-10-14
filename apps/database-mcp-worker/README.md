# Cloudflare Database MCP Worker

A Cloudflare-native MCP server for bounded PostgreSQL/MySQL reads, structured writes, and structured schema changes. Each logical connection has one database principal; native MySQL/PostgreSQL grants determine which operations succeed. Direct database URLs remain supported where plaintext transport is explicitly acceptable; Cloudflare Hyperdrive is supported for TLS-capable read and write paths.

## Minimal deployment

The normal deployment requires two Runtime Secrets:

- `MCP_ACCESS_TOKEN` — authenticates Cloudflare MCP Portal -> Worker.
- `DATABASE_CONFIG` — a flat map of connection ids to SQL URLs or strict Hyperdrive references.

Store both under **Worker Settings -> Variables and Secrets** as **Secret** values. The connection id is also the display name. Presence in the map enables a connection; remove an entry to disable it.

```json
{
  "scrape_relay": "mysql://user:password@host1:3306/scrape_relay",
  "analytics": "postgres://user:password@host2:5432/analytics"
}
```

The catalog accepts 1-50 IDs matching `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`. Values must be SQL URL strings or strict Hyperdrive references. Nested connection objects, legacy `read`/`write`/`admin` fields, per-connection settings, and unknown fields are rejected. There is no dual-format compatibility.

When one connection is configured, tools may omit `connection`. With multiple connections, tools require an explicit configured ID; the Worker never chooses by catalog order. `list_connections` returns only ID, dialect, and transport.

## MySQL server-level connection

MySQL may omit the database name when one account needs to access multiple databases on the same server:

```json
{ "mysql_server": "mysql://user:password@db.example.com:3306" }
```

`health_check` works without a default database. `inspect_schema` without `schema` lists databases visible to the account; schema-specific inspection requires `schema`. `get_schema_context` requires `schema` when the URL has no default database. Reads and structured mutations accept explicit `schema`; database grants remain the access boundary. PostgreSQL URLs require a database name.

## Hyperdrive

Hyperdrive references use the strict object form because bindings are configured in Wrangler/Cloudflare:

```json
{
  "reporting": { "hyperdrive": "REPORTING_HYPERDRIVE", "dialect": "postgres" }
}
```

The same selected binding and database principal serve reads and structured writes. Structured DDL remains direct-only and fails with `ADMIN_OPERATION_NOT_SUPPORTED` for Hyperdrive, without fallback.

## Direct mode

Direct mode accepts complete SQL URLs:

- PostgreSQL: `postgres://` or `postgresql://` (database name required)
- MySQL: `mysql://` (database name optional)

Dialect is derived from the URL. Direct URLs requesting TLS are rejected; use Hyperdrive for TLS-capable database paths.

## Global limits and database permissions

Safe defaults and hard maxima apply globally through Wrangler vars:

- `MAX_ROWS=500` (hard maximum 5,000)
- `MAX_RESULT_BYTES=1048576` (hard maximum 8 MiB)
- `MAX_SCHEMA_BYTES=524288` (hard maximum 4 MiB)
- `QUERY_TIMEOUT_MS=15000` (hard maximum 60,000)
- `MAX_WRITE_AFFECTED_ROWS=20` (hard maximum 100)

The selected database account's native grants control reads, inserts, updates, deletes, and DDL. The Worker uses no elevated credential fallback. Structured mutation limits, parameterization, rollback on affected-row overflow, query bounds, rate limiting, redacted errors, and no-replay behavior remain enforced. The `connection` id selects credentials; it does not grant permissions.

Deployment SQL examples under `deploy/sql/` remain optional starting points for accounts with different grant sets. PostgreSQL DDL requires suitable object ownership; MySQL DDL requires the corresponding database/table privileges.

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

- Each logical connection uses one account; the database grants determine operation access.
- `create_table` accepts only a bounded scalar type subset and literal defaults.
- `alter_table` supports only add/drop/rename column and rename table in v0.3.
- `create_index` supports ordinary column indexes only; expression/partial/fulltext/spatial/vendor-specific advanced indexes are excluded.
- DDL tools identify their targets explicitly and expose destructive risk through MCP annotations; the client owns user approval.
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

Monorepo CI runs unit checks plus real PostgreSQL 17 / MySQL 8.4 integration tests against native grants, structured mutation limits, and schema behavior. Unit checks cover flat configuration rejection, connection selection, global limits, Hyperdrive behavior, and schema-context formatting.

## Security notes

- Keep `DATABASE_CONFIG` as a Cloudflare Runtime Secret; never commit its real value.
- Do not log `DATABASE_CONFIG`, SQL URLs, database passwords, MCP bearer tokens, write values, write predicates, or generated admin SQL.
- `list_connections` exposes only non-secret ID, dialect, and transport metadata.
- Direct database URLs and Hyperdrive binding internals are never returned in MCP responses.

## License and provenance

MIT license and source provenance are preserved in `LICENSE` and `SOURCE.md`.
