# Database MCP Portal authentication

Database MCP uses Cloudflare MCP Portal as the supported client-facing ingress. The previous direct JWT OAuth resource-server compatibility path has been retired.

## Architecture

```text
MCP client
  -> Cloudflare MCP Portal
  -> Authorization: Bearer <MCP_ACCESS_TOKEN>
  -> database MCP Worker /mcp
  -> DATABASE_CONFIG (Secret)
       -> logical connection
            -> READ  -> direct SQL URL or Hyperdrive binding
            -> WRITE -> optional separate direct SQL URL or Hyperdrive binding
  -> least-privilege database identities
  -> database-native GRANT / RLS / views / routine policy
```

`MCP_ACCESS_TOKEN` authenticates only Portal -> Worker. Database credentials live only inside the `DATABASE_CONFIG` Runtime Secret for direct mode, or inside Cloudflare Hyperdrive for Hyperdrive mode. Never reuse the Portal token as a database credential.

Store the Portal credential and database catalog as Worker Runtime Secrets:

```bash
pnpm --filter database-mcp-worker exec wrangler secret put MCP_ACCESS_TOKEN
pnpm --filter database-mcp-worker exec wrangler secret put DATABASE_CONFIG
```

The Worker consumes the inbound Portal `Authorization` header before MCP/tool handling. Tools receive only a non-secret logical principal (`cloudflare-mcp-portal`) with logical `db:read` / `db:write` capability metadata. The real Portal credential is never forwarded to database code.

The scope metadata is not the database authorization boundary. A write succeeds only when the selected logical connection has explicit `write` configuration and the separately resolved writer identity has the required database-native privileges/policies.

## Retired client OAuth surface

The Worker no longer owns a direct client OAuth resource-server path. These runtime requirements remain retired:

- protected-resource metadata endpoint
- JWT/JWKS access-token verification
- `OAUTH_ISSUER`
- `OAUTH_AUDIENCE`
- `OAUTH_JWKS_URL`
- `OAUTH_REQUIRED_SCOPE`
- `MCP_ORIGIN_TOKEN`

Git history preserves the earlier OAuth design when historical investigation is needed.

## Security boundaries retained

Portal-only ingress does **not** weaken database authorization:

1. Existing read tools resolve only the READ credential.
2. Safe Write tools resolve only an explicitly configured WRITE credential.
3. Each read/write path selects exactly one explicit `direct` or `hyperdrive` transport; no fallback occurs.
4. Hyperdrive read/write bindings should use separate least-privilege database identities and cache-disabled configurations.
5. Direct credentials are stored inside the single `DATABASE_CONFIG` Runtime Secret; they are never exposed through ordinary text vars.
6. Database-native GRANTs, PostgreSQL RLS, restricted views, and routine/function permissions remain authoritative.
7. `query_read` stays read-only; write tools accept structured data/predicates instead of raw write SQL.
8. UPDATE/DELETE use an affected-row rollback guard in addition to database query timeouts.
9. Rate limiting and sanitized observability remain application-local.

## Acceptance checks

1. `/mcp` without a bearer or with the retired direct OAuth bearer is rejected with `401`.
2. Missing `MCP_ACCESS_TOKEN` configuration fails closed with `503`.
3. Missing `DATABASE_CONFIG` fails closed with `503 database_config_not_configured` after Portal authentication succeeds.
4. A browser `Origin` is rejected because direct browser clients are unsupported.
5. Correct Portal bearer reaches MCP and the inbound Authorization value is absent from tool/domain handling.
6. Portal discovers the five existing read tools plus `insert_rows`, `update_rows`, and `delete_rows`.
7. `list_connections` reports dialect/read transport plus `writeEnabled` and optional `writeTransport`, without SQL URLs, credentials, or binding names.
8. Connections without `write` remain read-only and return `WRITE_NOT_CONFIGURED` from write tools.
9. Writer resolution never falls back to read credentials or another transport.
10. Direct read/write SQL URLs never appear in MCP responses or logs.
11. Hyperdrive binding internals and database credentials never appear in MCP responses or logs.
12. Write row values, predicates, and generated parameter arrays are not logged.
13. `query_read` still rejects write SQL.
14. UPDATE/DELETE that exceed the configured affected-row maximum are rolled back and return `WRITE_LIMIT_EXCEEDED`.
15. PostgreSQL writer RLS and reader RLS remain effective.
16. Reader identities still cannot write; writer identities still cannot perform DDL/admin operations or execute dangerous routines.
17. MySQL Safe Write is used only with transactional table engines when rollback guarantees are required.
18. Rate limiting continues to use the stable logical Portal principal.
19. Direct URLs requesting TLS are rejected during configuration parsing.

## Deployment boundary

Production deployment remains Cloudflare Builds. The target ingress policy is the Worker's `workers.dev` endpoint with `workers_dev:true`, `preview_urls:false`, and no required custom domain or zone route.

`wrangler.jsonc` declares `MCP_ACCESS_TOKEN` and `DATABASE_CONFIG` as required secret names. Their values remain environment-owned Runtime Secrets and are not committed to Git. Hyperdrive resource IDs/bindings remain Wrangler/Cloudflare bindings.

Direct mode is only for publicly reachable legacy databases where plaintext transport is explicitly acceptable. Private-network routing through Workers VPC or Cloudflare Tunnel is not part of the direct contract.
