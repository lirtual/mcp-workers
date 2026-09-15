# Cloudflare Database MCP

A Cloudflare-native, read-only Model Context Protocol server for safely inspecting and querying existing PostgreSQL and MySQL databases through **Cloudflare Hyperdrive**.

`v0.1` deliberately keeps the capability surface small: database-native least privilege is the hard security boundary, while the Worker provides OAuth authentication, MCP tools, static logical connection routing, query/result bounds, rate limiting, sanitized errors, and structured logs.

## Architecture

```text
ChatGPT / MCP client
        |
        | OAuth bearer token + MCP
        v
Cloudflare Worker: database-mcp-worker
        |
        |-- OAuth resource-server verification
        |-- five read-only MCP tools
        |-- static logical connection catalog
        |-- abuse rate limiting
        |-- single-statement/read-query guardrails
        |-- row / payload / timeout bounds
        |-- sanitized structured logs
        v
Cloudflare Hyperdrive (query caching disabled)
        |
        v
Dedicated read-only database credential
        |
        +-- PostgreSQL
        +-- MySQL / MariaDB-compatible
```

The Worker never accepts a database password or connection string from an MCP caller. A logical connection id resolves only to an explicitly configured Hyperdrive binding.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `list_connections` | List non-secret logical connection metadata. |
| `inspect_schema` | Inspect schemas, tables/views, columns, primary/foreign keys, and indexes. |
| `query_read` | Run one bounded read query with parameters through a READ credential. |
| `explain` | Return a non-`ANALYZE` query plan. |
| `health_check` | Verify that one logical READ path is usable. |

All tools advertise `readOnlyHint: true`. Client annotations are UX hints only; database privileges remain authoritative.

## Runtime requirements

- Cloudflare Workers with `nodejs_compat`.
- Cloudflare Hyperdrive.
- MCP TypeScript SDK v2 (`@modelcontextprotocol/server`) for the 2026-07-28 protocol era while retaining stateless legacy compatibility.
- PostgreSQL through `pg` / node-postgres `>= 8.16.3`.
- MySQL through `mysql2 >= 3.13.0` with `disableEval: true`.
- An OAuth Authorization Server that issues JWT access tokens verifiable with JWKS. The Worker is a Resource Server; it does not issue tokens.

## Security model

Four layers intentionally remain separate:

1. **MCP tool surface** — v0.1 exposes read capabilities only.
2. **Hyperdrive binding** — every logical connection selects only a READ binding.
3. **Database credential** — the Hyperdrive configuration uses a dedicated read-only identity.
4. **Database-native policy** — GRANTs, PostgreSQL RLS, restricted views, and routine/function permissions decide what data can actually be read.

Worker-side SQL inspection rejects obvious writes, multi-statements, locking reads, MySQL `INTO OUTFILE`/`DUMPFILE`, named locks, and other unsafe constructs, but it is intentionally **not** treated as the authorization boundary.

### PostgreSQL hardening

Use a non-owner, non-superuser role with no `BYPASSRLS`, only required `CONNECT`/`USAGE`/`SELECT`, and no unnecessary sequence privileges. Audit function execution privileges carefully: syntactic `SELECT` can invoke a function, and new PostgreSQL functions can otherwise be executable by `PUBLIC` depending on how they are created/configured.

A starting template is in [`deploy/sql/postgres-readonly.sql`](deploy/sql/postgres-readonly.sql).

### MySQL hardening

Grant only required `SELECT` privileges. Do not grant write/DDL/admin privileges, `FILE`, `EXECUTE`, `LOCK TABLES`, or `GRANT OPTION`. Use views or column-level grants where sensitive columns must remain unavailable.

A starting template is in [`deploy/sql/mysql-readonly.sql`](deploy/sql/mysql-readonly.sql).

## Hyperdrive setup

Create Hyperdrive configurations using the dedicated read-only database credentials and **disable query caching**. Fresh reads are the safe default for an operational database assistant.

```bash
npx wrangler hyperdrive create prod-pg-read \
  --connection-string="postgres://mcp_reader:...@db.example.com:5432/app" \
  --caching-disabled

npx wrangler hyperdrive create prod-mysql-read \
  --connection-string="mysql://mcp_reader:...@db.example.com:3306/app" \
  --caching-disabled
```

If a configuration already exists:

```bash
npx wrangler hyperdrive update <HYPERDRIVE_ID> --caching-disabled
```

Hyperdrive pooling is the reason each Worker request can create a fresh `pg`/`mysql2` client instead of keeping global database connections alive.

## Worker configuration

Copy the example and replace every placeholder:

```bash
cp wrangler.jsonc.example wrangler.jsonc
```

`CONNECTIONS_JSON` is the v0.1 static connection catalog. Example:

```json
[
  {
    "id": "prod_pg",
    "displayName": "Production PostgreSQL",
    "dialect": "postgres",
    "binding": "PROD_PG_READ",
    "enabled": true,
    "defaultSchema": "public"
  }
]
```

The `binding` is deployment configuration and is never returned to MCP callers.

Global defaults:

- `MAX_ROWS=500`
- `MAX_RESULT_BYTES=1048576`
- `MAX_SCHEMA_BYTES=524288`
- `QUERY_TIMEOUT_MS=15000`

Per-connection values may be stricter but cannot raise the deployment maxima.

## OAuth configuration

Required Worker variables:

```text
OAUTH_ISSUER=https://auth.example.com
OAUTH_AUDIENCE=https://database-mcp.example.com/mcp
OAUTH_JWKS_URL=https://auth.example.com/.well-known/jwks.json
OAUTH_REQUIRED_SCOPE=db:read
```

The issuer string must exactly match the JWT `iss` claim. The token must have `sub` and `exp`, match the configured audience, and contain the required scope in either `scope` or `scp`.

The Worker publishes RFC 9728-style protected-resource metadata at:

```text
/.well-known/oauth-protected-resource/mcp
```

Unauthenticated `/mcp` requests are gated by the MCP SDK's web-standard bearer-auth middleware and receive a `WWW-Authenticate` challenge pointing to that resource metadata.

## Install, verify, and deploy

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run deploy
```

Before deploying, generate Cloudflare runtime types if you want a local generated binding file:

```bash
npm run cf-types
```

The Worker MCP endpoint is:

```text
https://<worker-host>/mcp
```

## Local development

Cloudflare supports a `localConnectionString` on Hyperdrive bindings. Add local read-only connection strings to your local `wrangler.jsonc`, then run:

```bash
npm run dev
```

Use a development OAuth issuer/token rather than bypassing authentication. The production code intentionally has no unauthenticated development mode.

## Tests

### Unit

```bash
npm test
```

Unit coverage focuses on the high-value pure seams: static catalog validation, SQL safety guardrails, result bounding, and timeout behavior.

### Real database integration

The integration suite expects disposable databases and separate read-only credentials:

```text
TEST_POSTGRES_ADMIN_URL
TEST_POSTGRES_READ_URL
TEST_MYSQL_ADMIN_URL
TEST_MYSQL_READ_URL
```

Run fixture setup and integration tests:

```bash
node scripts/setup-integration.mjs
npm run test:integration
```

The included GitHub Actions workflow starts PostgreSQL 17 and MySQL 8.4, builds read-only fixtures, verifies ordinary reads/schema/explain behavior, verifies PostgreSQL RLS, and directly confirms that the read credentials cannot update data or execute the fixture's side-effecting PostgreSQL function.

### Cloudflare staging gate

Local/CI database tests do **not** prove Hyperdrive or ChatGPT interoperability. Before releasing v0.1, deploy a staging Worker with real cache-disabled Hyperdrive bindings and verify:

- OAuth discovery and bearer-token validation;
- MCP tool discovery/calls from the target ChatGPT client;
- current `pg` and `mysql2` compatibility through Hyperdrive;
- query-cache-disabled behavior;
- rate-limit binding behavior;
- payload and timeout behavior.

## Operational guardrails

- `query_read` accepts exactly one statement and only the supported read-query shape (`SELECT`/CTE reads, plus PostgreSQL `VALUES`).
- A server-controlled outer `LIMIT` requests at most `rowLimit + 1` rows so truncation is detectable.
- MySQL read queries receive a server-controlled `MAX_EXECUTION_TIME` optimizer hint; PostgreSQL clients set server/client statement timeouts.
- Returned rows and schema metadata have serialized payload caps.
- Query results are never persisted.
- Logs contain SQL hash + a bounded literal-redacted preview, never result rows, bearer tokens, passwords, or connection strings.
- Rate-limit keys use a pseudonymous hash of the principal plus logical connection. Cloudflare's rate limiter is treated as approximate abuse control, not authorization or billing.
- `explain` is plain explain only; user-supplied `EXPLAIN`/`ANALYZE` is rejected by the read-query guard.

## Scope intentionally deferred

Not in v0.1: D1, Durable Objects, Hono, runtime connection onboarding, RBAC tables, raw write SQL, migrations, schema diffs, web admin UI, long-lived transactions, or DBX-style database-client functionality.

A future v0.2 can add separate WRITE Hyperdrive bindings plus structured `insert_rows` / `update_rows` / `delete_rows` tools without changing the permanent READ path.

## Primary references

- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- MCP 2026-07-28 specification: https://github.com/modelcontextprotocol/modelcontextprotocol/tree/main/docs/specification/2026-07-28
- Cloudflare Hyperdrive: https://developers.cloudflare.com/hyperdrive/
- Hyperdrive PostgreSQL / `pg`: https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/node-postgres/
- Hyperdrive MySQL / `mysql2`: https://developers.cloudflare.com/hyperdrive/examples/connect-to-mysql/mysql-drivers-and-libraries/mysql2/
- Hyperdrive query caching: https://developers.cloudflare.com/hyperdrive/concepts/query-caching/
- Workers Rate Limiting binding: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
