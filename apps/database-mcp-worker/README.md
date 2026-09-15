# Cloudflare Database MCP Worker

A Cloudflare-native, read-only MCP server for inspecting and querying existing PostgreSQL and MySQL databases through Cloudflare Hyperdrive.

## Current architecture

```text
MCP client
  -> Cloudflare MCP Portal
  -> Authorization: Bearer <MCP_ACCESS_TOKEN>
  -> database-mcp-worker /mcp
  -> static logical connection catalog
  -> READ-only Hyperdrive binding
  -> dedicated least-privilege database credential
  -> PostgreSQL / MySQL
```

The Worker never accepts a database password or connection string from an MCP caller. `MCP_ACCESS_TOKEN` is only the Portal-to-Worker credential; it is consumed before MCP/tool handling and is never reused for database access.

## MCP tools

- `list_connections` — non-secret logical connection metadata
- `inspect_schema` — bounded schema/table/column/index/foreign-key discovery
- `query_read` — one bounded read query through a READ credential
- `explain` — non-`ANALYZE` read query plan
- `health_check` — health of one logical READ path

All tools are read-only by product contract. Tool annotations are UX hints; database-native privileges are the hard authorization boundary.

## Security model

1. Portal ingress validates this Worker's dedicated `MCP_ACCESS_TOKEN`.
2. The MCP surface exposes read capabilities only.
3. A logical connection resolves only to statically configured READ Hyperdrive bindings.
4. Hyperdrive uses dedicated least-privilege database credentials.
5. Database-native GRANTs, PostgreSQL RLS, restricted views, and routine/function permissions remain authoritative.

Worker SQL validation rejects obvious writes, multi-statements, locking reads, unsafe explain modes, and other unsupported shapes, but it is intentionally not the final authorization mechanism.

### PostgreSQL

Use a non-owner, non-superuser role with no `BYPASSRLS`, only required `CONNECT`/`USAGE`/`SELECT`, and carefully reviewed function execution privileges. A hardening template is in `deploy/sql/postgres-readonly.sql`.

### MySQL

Grant only required `SELECT`; do not grant write/DDL/admin privileges, `FILE`, `EXECUTE`, `LOCK TABLES`, or `GRANT OPTION`. A hardening template is in `deploy/sql/mysql-readonly.sql`.

## Hyperdrive and configuration

Create Hyperdrive configurations with the dedicated read-only credentials and disable Hyperdrive query caching. Copy `wrangler.jsonc.example` to a local/deployment `wrangler.jsonc` and replace placeholder Hyperdrive IDs/bindings.

`CONNECTIONS_JSON` defines the static public logical connection catalog. The MCP caller cannot create connections, provide arbitrary bindings, or override credentials.

Default deployment bounds include:

- `MAX_ROWS=500`
- `MAX_RESULT_BYTES=1048576`
- `MAX_SCHEMA_BYTES=524288`
- `QUERY_TIMEOUT_MS=15000`

Per-connection limits may be stricter but must not raise deployment maxima.

## Portal authentication

Store a dedicated Worker secret:

```bash
pnpm --filter database-mcp-worker exec wrangler secret put MCP_ACCESS_TOKEN
```

Configure Cloudflare MCP Portal to send the same value as upstream Bearer authentication. Worker-owned OAuth/JWKS/resource-server validation is not part of the current architecture.

See `docs/mcp-portal-migration.md` for the current Portal contract and acceptance checks.

## Development and verification

```bash
pnpm install --frozen-lockfile
pnpm --filter database-mcp-worker check
```

Root monorepo CI owns both ordinary application checks and real PostgreSQL 17 / MySQL 8.4 integration coverage. The integration suite uses disposable databases plus separate admin/read credentials, prepares fixtures through `scripts/setup-integration.mjs`, and verifies that READ credentials cannot mutate data.

Repository cleanup must not remove that integration gate merely because the old app-local workflow is gone.

## Deployment state

This source tree is deployable as `database-mcp-worker`, but source/CI acceptance does not imply a production Worker/Portal instance exists. Creating or cutting over a live deployment remains a separate operational action.

## License and provenance

MIT license and source provenance are preserved in `LICENSE` and `SOURCE.md`.
