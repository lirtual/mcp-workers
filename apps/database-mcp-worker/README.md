# Cloudflare Database MCP

A Cloudflare-native, read-only Model Context Protocol server for safely inspecting and querying existing PostgreSQL and MySQL databases through **Cloudflare Hyperdrive**.

`v0.1` deliberately keeps the capability surface small: database-native least privilege is the hard security boundary, while the Worker provides Portal-only ingress authentication, MCP tools, static logical connection routing, query/result bounds, rate limiting, sanitized errors, and structured logs.

## Architecture

```text
ChatGPT / MCP client
        |
        | Cloudflare MCP Portal / managed client auth
        v
Cloudflare MCP Portal
        |
        | Authorization: Bearer <MCP_ACCESS_TOKEN>
        v
Cloudflare Worker: database-mcp-worker
        |
        |-- Portal origin-token verification
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
- Cloudflare MCP Portal as the only supported client ingress.
- MCP TypeScript SDK v2 (`@modelcontextprotocol/server`) for the 2026-07-28 protocol era while retaining stateless transport compatibility.
- PostgreSQL through `pg` / node-postgres `>= 8.16.3`.
- MySQL through `mysql2 >= 3.13.0` with `disableEval: true`.

## Security model

Five layers intentionally remain separate:

1. **Portal ingress** — each Worker validates its dedicated `MCP_ACCESS_TOKEN` and consumes the incoming `Authorization` header before MCP/tool handling.
2. **MCP tool surface** — v0.1 exposes read capabilities only.
3. **Hyperdrive binding** — every logical connection selects only a READ binding.
4. **Database credential** — the Hyperdrive configuration uses a dedicated read-only identity.
5. **Database-native policy** — GRANTs, PostgreSQL RLS, restricted views, and routine/function permissions decide what data can actually be read.

The Portal credential is never reused as a database credential and is not propagated into MCP `AuthInfo`. The Worker supplies a stable non-secret logical principal (`cloudflare-mcp-portal`) with the `db:read` scope for audit hashing and rate limiting.

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

## Portal authentication

Store a dedicated high-entropy Portal → Worker secret:

```bash
npx wrangler secret put MCP_ACCESS_TOKEN
```

Configure the Database server in Cloudflare MCP Portal with Bearer upstream authentication using the same value. Clients connect to the **Portal URL**, not directly to the Worker.

Direct `/mcp` requests without the correct bearer are rejected. The Worker removes `Authorization` before handing the request to the MCP transport and tools. Worker-owned JWT/JWKS validation, OAuth issuer/audience configuration, and OAuth protected-resource metadata are intentionally not supported after the Portal-only cutover.

`MCP_ACCESS_TOKEN` is ingress-only. Never reuse it for Hyperdrive, PostgreSQL, MySQL, or any other upstream service.

See [`docs/mcp-portal-migration.md`](docs/mcp-portal-migration.md) for the contract and acceptance checks.

## Install, verify, and deploy

```bash
pnpm install
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run deploy:dry-run
```

Before deploying, generate Cloudflare runtime types if you want a local generated binding file:

```bash
pnpm run cf-types
```

The Worker MCP endpoint is:

```text
https://<worker-host>/mcp
```

Production clients should use the MCP Portal URL rather than this origin URL.

## Local development

Cloudflare supports a `localConnectionString` on Hyperdrive bindings. Add local read-only connection strings to your local `wrangler.jsonc`, configure a development `MCP_ACCESS_TOKEN`, then run:

```bash
pnpm run dev
```

The production code intentionally has no unauthenticated development mode.

## Tests

### Unit

```bash
pnpm test
```

Unit coverage focuses on the high-value pure seams: Portal authentication, static catalog validation, SQL safety guardrails, result bounding, and timeout behavior.

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
pnpm run test:integration
```

The included GitHub Actions workflow starts PostgreSQL 17 and MySQL 8.4, builds read-only fixtures, verifies ordinary reads/schema/explain behavior, verifies PostgreSQL RLS, and directly confirms that the read credentials cannot update data or execute the fixture's side-effecting PostgreSQL function.

### Cloudflare staging gate

Local/CI database tests do **not** prove Hyperdrive or Portal interoperability. Before production cutover, deploy a staging Worker with real cache-disabled Hyperdrive bindings and verify:

- Portal upstream authentication with `MCP_ACCESS_TOKEN`;
- direct invalid/missing bearer rejection;
- MCP tool discovery/calls through Portal;
- current `pg` and `mysql2` compatibility through Hyperdrive;
- query-cache-disabled behavior;
- rate-limit binding behavior;
- payload and timeout behavior;
- no ingress token or database credential leakage in logs/responses.

## Operational guardrails

- `query_read` accepts exactly one statement and only the supported read-query shape (`SELECT`/CTE reads, plus PostgreSQL `VALUES`).
- A server-controlled outer `LIMIT` requests at most `rowLimit + 1` rows so truncation is detectable.
- MySQL read queries receive a server-controlled `MAX_EXECUTION_TIME` optimizer hint; PostgreSQL clients set server/client statement timeouts.
- Returned rows and schema metadata have serialized payload caps.
- Query results are never persisted.
- Logs contain SQL hash + a bounded literal-redacted preview, never result rows, bearer tokens, passwords, or connection strings.
- Rate-limit keys use a pseudonymous hash of the stable Portal principal plus logical connection. Cloudflare's rate limiter is treated as approximate abuse control, not authorization or billing.
- `explain` is plain explain only; user-supplied `EXPLAIN`/`ANALYZE` is rejected by the read-query guard.

## Historical specification note

`docs/spec.md` records the original v0.1 resource-server design and therefore still discusses direct OAuth/JWT validation. The current runtime contract is Portal-only; this README and `docs/mcp-portal-migration.md` supersede that authentication section. The database read-only, Hyperdrive, SQL safety, result-bound, and database-native authorization requirements from the original specification remain in force.

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
