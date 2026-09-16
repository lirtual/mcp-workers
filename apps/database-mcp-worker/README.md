# Cloudflare Database MCP Worker

A Cloudflare-native MCP server for bounded PostgreSQL/MySQL reads plus optional structured Safe Write. Each logical connection explicitly uses Cloudflare Hyperdrive or a narrow direct plaintext compatibility path, and write credentials are configured separately from read credentials.

## Architecture

```text
MCP client
  -> Cloudflare MCP Portal
  -> Authorization: Bearer <MCP_ACCESS_TOKEN>
  -> database-mcp-worker /mcp
  -> static logical connection catalog
       -> READ  -> direct SQL URL Secret or Hyperdrive binding
       -> WRITE -> optional, separate direct SQL URL Secret or Hyperdrive binding
  -> least-privilege database identities
  -> PostgreSQL / MySQL
```

Read and write transports are selected explicitly per logical connection and may differ. The Worker never auto-detects transport, never auto-downgrades TLS, never falls back between transports, and never reuses a read credential for writes.

`MCP_ACCESS_TOKEN` authenticates Portal -> Worker only. Database credentials authenticate Worker -> database only. MCP callers cannot submit database URLs, passwords, binding names, or arbitrary write SQL.

## MCP tools

Read tools:

- `list_connections` — non-secret logical metadata including dialect, read transport, `writeEnabled`, and optional `writeTransport`
- `inspect_schema` — bounded schema/table/column/index/foreign-key discovery
- `query_read` — one bounded read query through the READ credential
- `explain` — non-`ANALYZE` read plan
- `health_check` — health of the READ path

Safe Write tools:

- `insert_rows` — structured 1–100 row insert
- `update_rows` — structured update with AND-only equality/membership/null predicates
- `delete_rows` — structured delete with the same predicate language

`query_read` remains read-only and continues rejecting writes. Safe Write tools never accept raw SQL. They generate dialect-specific parameterized SQL internally.

## Security model

1. Portal ingress validates this Worker's dedicated `MCP_ACCESS_TOKEN`.
2. Read tools resolve only the configured READ credential.
3. Write tools resolve only an explicitly configured WRITE credential; otherwise they return `WRITE_NOT_CONFIGURED`.
4. Database-native GRANTs, PostgreSQL RLS, restricted views, and routine/function permissions remain authoritative.
5. UPDATE/DELETE run in an explicit transaction and roll back when the database-reported affected-row count exceeds the configured maximum.
6. Write values and predicates are not sent through the read SQL logging path.
7. A connection or transport failure never falls back to another credential or transport.

### Writer identities

Writer accounts should receive only the minimum `SELECT` required for predicates plus required `INSERT`, `UPDATE`, and `DELETE` privileges on application tables. Do not grant DDL/admin privileges, arbitrary routine execution, `GRANT OPTION`, superuser-equivalent privileges, or PostgreSQL `BYPASSRLS`.

PostgreSQL RLS must apply to writer identities as well as readers. MySQL Safe Write rollback guarantees require transactional table engines such as InnoDB; non-transactional tables are outside the v0.2 safety guarantee.

## Connection configuration

`CONNECTIONS_JSON` remains the static logical connection catalog. Existing v0.1 entries remain valid and read-only. Add an optional `write` object to opt a connection into Safe Write.

### Direct read + direct write

Direct mode exists for legacy databases that cannot enable TLS. Both read and write direct paths use one complete SQL URL Worker Secret each; split host/user/password variables are not supported.

```json
{
  "id": "legacy_mysql",
  "displayName": "Legacy MySQL",
  "transport": "direct",
  "urlSecret": "LEGACY_MYSQL_DATABASE_URL",
  "write": {
    "transport": "direct",
    "urlSecret": "LEGACY_MYSQL_WRITE_URL",
    "maxAffectedRows": 20
  },
  "enabled": true
}
```

PostgreSQL supports `postgres://` / `postgresql://`; MySQL uses `mysql://`. Direct dialect is derived from the URL scheme. A direct writer URL must resolve to the same dialect as the logical read connection. Direct URLs requesting TLS are rejected; use Hyperdrive for TLS-capable databases.

Because direct mode is plaintext, use it only when that network risk is explicitly acceptable. Workers VPC / Cloudflare Tunnel transport is not part of v0.2.

### Hyperdrive read + Hyperdrive write

Use separate cache-disabled Hyperdrive configurations backed by separate database identities:

```json
{
  "id": "prod_pg",
  "displayName": "Production PostgreSQL",
  "transport": "hyperdrive",
  "dialect": "postgres",
  "binding": "PROD_PG_READ",
  "write": {
    "transport": "hyperdrive",
    "binding": "PROD_PG_WRITE",
    "maxAffectedRows": 20
  },
  "enabled": true,
  "defaultSchema": "public"
}
```

A logical connection may also mix transports, for example Hyperdrive READ plus direct WRITE. Transport selection remains explicit; there is no automatic fallback.

## Safe Write contract

### Insert

- 1–100 rows per invocation
- 1–100 columns per row
- every row must have the same column set
- one parameterized multi-row INSERT statement
- write payload maximum 256 KiB
- no UPSERT / `ON CONFLICT` / `ON DUPLICATE KEY`
- no client-supplied `RETURNING`

### Update / delete

`where` must be non-empty and supports only AND composition with:

- scalar equality
- `{ "eq": value }`
- `{ "in": [value, ...] }`, maximum 100 values
- `{ "isNull": true | false }`

Direct `null` shorthand, OR, ranges, LIKE/regex, joins, subqueries, raw expressions, functions, and nested predicate trees are not supported in v0.2.

UPDATE/DELETE use one physical connection and an explicit transaction. If `affectedRows` exceeds `MAX_WRITE_AFFECTED_ROWS` (or a stricter per-connection `write.maxAffectedRows`), the transaction is rolled back and the tool returns `WRITE_LIMIT_EXCEEDED`.

## Runtime limits

Default deployment bounds:

- `MAX_ROWS=500`
- `MAX_RESULT_BYTES=1048576`
- `MAX_SCHEMA_BYTES=524288`
- `QUERY_TIMEOUT_MS=15000`
- `MAX_WRITE_AFFECTED_ROWS=20` (hard maximum 100)

Per-connection write limits may be stricter but cannot raise the deployment maximum.

## Portal authentication

Store a dedicated Worker secret:

```bash
pnpm --filter database-mcp-worker exec wrangler secret put MCP_ACCESS_TOKEN
```

Configure Cloudflare MCP Portal to send the same value as upstream Bearer authentication. The logical principal advertises `db:read` and `db:write`; actual write authorization still requires an explicit `write` connection configuration and database-native writer privileges.

See `docs/mcp-portal-migration.md` for the Portal contract.

## Development and verification

```bash
pnpm install --frozen-lockfile
pnpm --filter database-mcp-worker check
```

Monorepo CI runs ordinary application checks plus real PostgreSQL 17 / MySQL 8.4 integration tests. Integration uses separate admin, reader, and writer identities and verifies reads, writes, PostgreSQL RLS, reader/write privilege separation, DDL/routine denial, and UPDATE rollback when the affected-row limit is exceeded.

Hyperdrive compatibility still requires Cloudflare staging verification with real cache-disabled bindings. Source/CI acceptance does not itself prove that production bindings, Secrets, or database endpoints are configured.

## Scope intentionally deferred

Not in v0.2:

- raw write SQL or general `execute_sql`
- DDL, migrations, schema changes, or database administration
- UPSERT
- stored procedure/function execution
- multi-statement batch SQL
- stateful MCP sessions or long-running client transactions
- dynamic connection onboarding / D1 registry
- table allowlists duplicated in Worker configuration
- ORM or general SQL AST/query-builder framework
- direct TLS mode or automatic TLS discovery
- Workers VPC / Cloudflare Tunnel transport implementation
- MySQL non-transactional table safety guarantees

## License and provenance

MIT license and source provenance are preserved in `LICENSE` and `SOURCE.md`.
