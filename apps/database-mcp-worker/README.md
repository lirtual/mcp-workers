# Cloudflare Database MCP Worker

A Cloudflare-native MCP server for safe PostgreSQL and MySQL access through explicit `direct` or `hyperdrive` transports. v0.2 keeps the existing read-only SQL surface and adds opt-in structured row writes through separate writer credentials.

## Architecture

```text
MCP client
  -> Cloudflare MCP Portal
  -> Authorization: Bearer <MCP_ACCESS_TOKEN>
  -> database-mcp-worker /mcp
  -> static logical connection catalog
       -> READ transport  -> dedicated read-only credential
       -> optional WRITE transport -> dedicated writer credential
  -> PostgreSQL / MySQL
```

Each logical connection chooses its READ transport and may independently opt into a WRITE transport. The Worker never accepts database credentials from MCP callers, never automatically falls back between transports, and never reuses a READ credential for writes.

## MCP tools

Read tools:

- `list_connections` — non-secret logical connection and capability metadata
- `inspect_schema` — bounded schema/table/column/index/foreign-key discovery
- `query_read` — one bounded read query through the READ credential
- `explain` — non-`ANALYZE` read query plan
- `health_check` — health of one logical READ path

Safe Write tools:

- `insert_rows` — parameterized insert of 1–100 rows into one table
- `update_rows` — structured targeted update with affected-row rollback protection
- `delete_rows` — structured targeted delete with affected-row rollback protection

`query_read` remains read-only and still rejects write SQL. v0.2 does not expose arbitrary write SQL, DDL, stored-procedure execution, batch SQL, or long-lived sessions.

## Security model

1. Portal ingress validates this Worker's dedicated `MCP_ACCESS_TOKEN`.
2. READ tools use only the existing dedicated read credential.
3. WRITE tools are available only when the logical connection has an explicit `write` configuration and use only its separate writer credential.
4. Structured writes generate parameterized SQL internally; MCP callers cannot supply raw write SQL or SQL expressions.
5. UPDATE and DELETE execute inside an explicit transaction and roll back when affected rows exceed the configured limit.
6. Database-native GRANTs, PostgreSQL RLS, restricted views, and routine/function permissions remain the authoritative authorization boundary.
7. Credentials, row values, predicate values, generated parameter arrays, and raw driver errors are not returned or written to write-operation logs.

### PostgreSQL

Use a non-owner, non-superuser reader role with no `BYPASSRLS` and only required read privileges. Use a separate writer role with only the required `SELECT`/`INSERT`/`UPDATE`/`DELETE` grants and reviewed RLS policies. Do not grant `BYPASSRLS`, broad function execution, DDL, role administration, or schema ownership.

Templates:

- `deploy/sql/postgres-readonly.sql`
- `deploy/sql/postgres-writer.sql`

### MySQL

Keep reader and writer users separate. The writer should receive only the table-level `SELECT`/`INSERT`/`UPDATE`/`DELETE` privileges it needs. Do not grant DDL/admin privileges, `FILE`, `EXECUTE`, `LOCK TABLES`, `PROCESS`, or `GRANT OPTION`.

Safe Write rollback protection requires transactional tables such as InnoDB. Non-transactional table engines are outside the v0.2 safety guarantee.

Templates:

- `deploy/sql/mysql-readonly.sql`
- `deploy/sql/mysql-writer.sql`

## Connection configuration

`CONNECTIONS_JSON` remains a static catalog. Existing top-level transport fields describe the READ path. An optional `write` object enables Safe Write.

### Direct read + direct write

```json
{
  "id": "legacy_mysql",
  "displayName": "Legacy MySQL",
  "transport": "direct",
  "urlSecret": "LEGACY_MYSQL_READ_URL",
  "write": {
    "transport": "direct",
    "urlSecret": "LEGACY_MYSQL_WRITE_URL"
  },
  "enabled": true
}
```

Direct credentials use complete SQL URL Worker Secrets only. Split host/user/password variables are not supported. Direct remains the plaintext legacy compatibility path; URLs that request TLS are rejected. A direct writer URL must resolve to the same database dialect as the logical READ connection.

### Hyperdrive read + Hyperdrive write

```json
{
  "id": "prod_pg",
  "displayName": "Production PostgreSQL",
  "transport": "hyperdrive",
  "dialect": "postgres",
  "binding": "PROD_PG_READ",
  "write": {
    "transport": "hyperdrive",
    "binding": "PROD_PG_WRITE"
  },
  "enabled": true,
  "defaultSchema": "public"
}
```

READ and WRITE bindings must be independent and backed by different database identities. Hyperdrive READ configurations should keep query caching disabled when strict read-after-write consistency is required. Hyperdrive write compatibility must be verified in Cloudflare staging with the real bindings before production cutover.

READ and WRITE transports may differ for one logical connection. No global write transport or automatic fallback exists.

## Structured write contract

### Insert

`insert_rows` accepts one table and 1–100 row objects. Every row must have the same column set. The Worker emits one multi-row parameterized INSERT. The request payload is capped at 256 KiB.

The result contains `affectedRows`. A single-row MySQL insert may also return a meaningful `insertId`. Generic PostgreSQL `RETURNING *`, upsert, and client-supplied returning expressions are not included.

### Update and delete

`update_rows` and `delete_rows` require a non-empty structured `where` mapping. Multiple predicates are combined with AND only.

Supported predicates:

- scalar string/number/boolean shorthand → equality
- `{ "eq": value }`
- `{ "in": [value, ...] }` with 1–100 values
- `{ "isNull": true }` / `{ "isNull": false }`

Direct `null` shorthand is rejected. OR, ranges, LIKE, regex, joins, subqueries, functions, raw expressions, nested predicate trees, and arbitrary SQL are not supported.

UPDATE and DELETE run in one transaction. The database reports the affected-row count before commit. If it exceeds the effective limit, the Worker rolls back and returns `WRITE_LIMIT_EXCEEDED`.

## Write limits

- `MAX_WRITE_AFFECTED_ROWS`: default `20`, hard maximum `100`
- insert rows: maximum `100`
- write payload: maximum `256 KiB`
- predicate columns: maximum `20`
- values in one `IN` predicate: maximum `100`
- set/insert columns: maximum `100`

A connection may set a stricter `write.maxAffectedRows`; it cannot raise the deployment maximum.

Existing read defaults remain:

- `MAX_ROWS=500`
- `MAX_RESULT_BYTES=1048576`
- `MAX_SCHEMA_BYTES=524288`
- `QUERY_TIMEOUT_MS=15000`

## Capability discovery

`list_connections` exposes only non-secret metadata, including:

- logical id/display name
- dialect
- READ transport
- enabled/default schema metadata
- `writeEnabled`
- `writeTransport` when configured

It never exposes Secret names, binding names, SQL URLs, hosts, users, or passwords.

A write invocation against a connection without a writer returns `WRITE_NOT_CONFIGURED`. Missing writer Secrets/bindings fail closed as `CONNECTION_UNAVAILABLE`; the Worker never falls back to READ credentials.

## Portal authentication

Store the Worker ingress secret:

```bash
pnpm --filter database-mcp-worker exec wrangler secret put MCP_ACCESS_TOKEN
```

Configure Cloudflare MCP Portal to send the same value as upstream Bearer authentication. The Worker consumes it before MCP handling. The logical AuthInfo advertises `db:read` and `db:write`; actual write authorization still depends on per-connection writer configuration and database-native privileges.

See `docs/mcp-portal-migration.md` for the Portal contract.

## Development and verification

```bash
pnpm install --frozen-lockfile
pnpm --filter database-mcp-worker check
```

Root CI also runs real PostgreSQL 17 and MySQL 8.4 integration tests. The integration environment creates separate reader and writer identities and verifies:

- existing read behavior and PostgreSQL reader RLS
- reader identities cannot mutate data or execute side-effecting routines
- structured INSERT/UPDATE/DELETE succeed through writer identities
- PostgreSQL writer RLS remains enforced
- UPDATE and DELETE roll back when the affected-row limit is exceeded
- writer identities cannot perform DDL or execute the protected routine
- MySQL write fixtures use InnoDB

## Deployment

`wrangler.jsonc.example` shows a mixed direct/Hyperdrive deployment with separate READ and WRITE runtime credentials. Preserve Dashboard-managed Secrets and real Hyperdrive IDs when using the checked-in template; the file contains placeholders only.

The source/CI contract does not by itself prove a production database is reachable. Direct and Hyperdrive paths should be smoke-tested from the deployed Worker before enabling Safe Write on production data.

## Out of scope for v0.2

- arbitrary/raw write SQL
- DDL or schema migration tools
- stored procedure/function execution
- UPSERT / `ON CONFLICT` / `ON DUPLICATE KEY`
- batch SQL and multi-statement execution
- session pinning or long-lived transactions
- table allowlists duplicated in Worker configuration
- per-user RBAC or a second MCP token
- dynamic connection onboarding, D1 registry, or web admin UI
- ORM/general SQL AST/expression framework
- custom connection-pool subsystem
- VPC/Tunnel transport work

## License and provenance

MIT license and source provenance are preserved in `LICENSE` and `SOURCE.md`.
