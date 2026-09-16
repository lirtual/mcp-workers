# Cloudflare Database MCP Worker

A Cloudflare-native, read-only MCP server for inspecting and querying existing PostgreSQL and MySQL databases through either Cloudflare Hyperdrive or a deliberately narrow direct plaintext compatibility path.

## Current architecture

```text
MCP client
  -> Cloudflare MCP Portal
  -> Authorization: Bearer <MCP_ACCESS_TOKEN>
  -> database-mcp-worker /mcp
  -> static logical connection catalog
       -> transport=hyperdrive -> READ Hyperdrive binding -> TLS-capable database
       -> transport=direct     -> SQL URL Worker Secret -> plaintext legacy database
  -> dedicated least-privilege database credential
  -> PostgreSQL / MySQL
```

Transport is selected explicitly per logical connection. The Worker never auto-detects transport, never auto-downgrades TLS, and never falls back from Hyperdrive to direct.

The Worker never accepts a database password or connection string from an MCP caller. `MCP_ACCESS_TOKEN` is only the Portal-to-Worker credential; it is consumed before MCP/tool handling and is never reused for database access.

## MCP tools

- `list_connections` — non-secret logical connection metadata, including resolved dialect and transport
- `inspect_schema` — bounded schema/table/column/index/foreign-key discovery
- `query_read` — one bounded read query through a READ credential
- `explain` — non-`ANALYZE` read query plan
- `health_check` — health of one logical READ path

All tools are read-only by product contract. Tool annotations are UX hints; database-native privileges are the hard authorization boundary.

## Security model

1. Portal ingress validates this Worker's dedicated `MCP_ACCESS_TOKEN`.
2. The MCP surface exposes read capabilities only.
3. A logical connection resolves only to one statically configured `direct` or `hyperdrive` transport.
4. The selected transport uses a dedicated least-privilege database credential.
5. Database-native GRANTs, PostgreSQL RLS, restricted views, and routine/function permissions remain authoritative.

Worker SQL validation rejects obvious writes, multi-statements, locking reads, unsafe explain modes, and other unsupported shapes, but it is intentionally not the final authorization mechanism.

### PostgreSQL

Use a non-owner, non-superuser role with no `BYPASSRLS`, only required `CONNECT`/`USAGE`/`SELECT`, and carefully reviewed function execution privileges. A hardening template is in `deploy/sql/postgres-readonly.sql`.

### MySQL

Grant only required `SELECT`; do not grant write/DDL/admin privileges, `FILE`, `EXECUTE`, `LOCK TABLES`, or `GRANT OPTION`. A hardening template is in `deploy/sql/mysql-readonly.sql`.

## Connection configuration

`CONNECTIONS_JSON` defines the static public logical connection catalog. Every connection must explicitly declare `transport`.

### Direct transport

Direct mode exists only for legacy databases that cannot enable TLS. It is plaintext-only in v0.1 and should not be treated as a feature-equivalent replacement for Hyperdrive.

Configure one Worker Secret containing the complete SQL URL:

```bash
pnpm --filter database-mcp-worker exec wrangler secret put LEGACY_MYSQL_DATABASE_URL
```

Example secret value:

```text
mysql://mcp_reader:password@db.example.com:3306/app
```

PostgreSQL URLs support `postgres://` and `postgresql://`; MySQL uses `mysql://`. The dialect is derived from the URL scheme and must not be duplicated in `CONNECTIONS_JSON`.

Catalog example:

```json
{
  "id": "legacy_mysql",
  "displayName": "Legacy MySQL",
  "transport": "direct",
  "urlSecret": "LEGACY_MYSQL_DATABASE_URL",
  "enabled": true
}
```

Direct mode does **not** support split variables such as `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_DIALECT`, or `DATABASE_TLS`. A direct URL that requests TLS is rejected. Plaintext directives such as PostgreSQL `sslmode=disable` are accepted but are unnecessary.

Because direct mode is plaintext, the database endpoint should only be used when that risk is explicitly acceptable. Private-network routing through Workers VPC/Tunnel is not part of this v0.1 path.

### Hyperdrive transport

Hyperdrive remains the preferred path for databases that support TLS. Create a cache-disabled Hyperdrive configuration using the dedicated read-only database credential, then declare the binding and dialect:

```json
{
  "id": "prod_pg",
  "displayName": "Production PostgreSQL",
  "transport": "hyperdrive",
  "dialect": "postgres",
  "binding": "PROD_PG_READ",
  "enabled": true,
  "defaultSchema": "public"
}
```

A Hyperdrive failure remains a Hyperdrive failure; the Worker never falls back to direct.

### Mixed deployment

One Worker may contain both transports:

```json
[
  {
    "id": "legacy_mysql",
    "displayName": "Legacy MySQL",
    "transport": "direct",
    "urlSecret": "LEGACY_MYSQL_DATABASE_URL",
    "enabled": true
  },
  {
    "id": "prod_pg",
    "displayName": "Production PostgreSQL",
    "transport": "hyperdrive",
    "dialect": "postgres",
    "binding": "PROD_PG_READ",
    "enabled": true,
    "defaultSchema": "public"
  }
]
```

The MCP caller cannot create connections, provide arbitrary bindings or URLs, or override credentials.

## Runtime limits

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

Root monorepo CI owns ordinary application checks and real PostgreSQL 17 / MySQL 8.4 integration coverage. The integration suite uses disposable databases plus separate admin/read credentials, prepares fixtures through `scripts/setup-integration.mjs`, and verifies direct PostgreSQL/MySQL reads while independently proving that the READ credentials cannot mutate data.

Hyperdrive compatibility still requires Cloudflare staging verification with real cache-disabled Hyperdrive bindings. Direct support should only be advertised after the corresponding Workers runtime staging path succeeds.

## Deployment state

This source tree is deployable as `database-mcp-worker`, but source/CI acceptance does not imply a production Worker/Portal instance or reachable direct database exists. Live Cloudflare binding/Secret configuration and staging smoke tests remain operational deployment actions.

## Scope intentionally deferred

Not in v0.1:

- automatic transport fallback or TLS discovery
- direct TLS configuration
- split direct database variables
- Workers VPC / Cloudflare Tunnel integration for private databases
- PgBouncer / ProxySQL compatibility layers
- D1 connection registry or runtime onboarding
- ORM or custom connection pooling
- raw write SQL, migrations, schema diffs, or web administration UI

## License and provenance

MIT license and source provenance are preserved in `LICENSE` and `SOURCE.md`.
