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
            -> ADMIN -> optional separate direct SQL URL or Hyperdrive binding
  -> separate least-privilege database identities
  -> database-native privileges / RLS / ownership / policy
```

`MCP_ACCESS_TOKEN` authenticates only Portal -> Worker. Database credentials live only inside the `DATABASE_CONFIG` Runtime Secret for direct mode, or inside Cloudflare Hyperdrive for Hyperdrive mode. Never reuse the Portal token as a database credential.

Store the Portal credential and database catalog as Worker Runtime Secrets:

```bash
pnpm --filter database-mcp-worker exec wrangler secret put MCP_ACCESS_TOKEN
pnpm --filter database-mcp-worker exec wrangler secret put DATABASE_CONFIG
```

The Worker consumes the inbound Portal `Authorization` header before MCP/tool handling. Tools receive only a non-secret logical principal (`cloudflare-mcp-portal`) with logical `db:read` / `db:write` / `db:admin` capability metadata. The real Portal credential is never forwarded to database code.

The scope metadata is not the database authorization boundary. A write succeeds only when the logical connection has explicit `write` configuration plus a separately resolved writer identity with the required native privileges. An Admin/DDL operation additionally requires explicit `admin` configuration plus a separately resolved ADMIN identity with the required database-native DDL/ownership privileges.

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

1. Read tools resolve only the READ credential.
2. Safe Write tools resolve only an explicitly configured WRITE credential.
3. Safe Admin/DDL tools resolve only an explicitly configured ADMIN credential.
4. No READ / WRITE / ADMIN credential or transport fallback occurs.
5. Hyperdrive bindings should use separate least-privilege database identities for each configured capability.
6. Direct credentials remain inside the `DATABASE_CONFIG` Runtime Secret; they are never exposed through ordinary text vars or MCP results.
7. Database-native privileges, PostgreSQL RLS/ownership, restricted views, and routine/function permissions remain authoritative.
8. `query_read` stays read-only; Safe Write accepts structured data/predicates instead of raw write SQL.
9. Safe Admin accepts structured DDL inputs only; arbitrary DDL/admin SQL is not exposed.
10. `drop_table`, `drop_index`, and drop-column operations require explicit confirmation before execution and are not automatically retried after ambiguous execution.
11. UPDATE/DELETE retain the affected-row rollback guard in addition to database query timeouts.
12. Rate limiting and sanitized observability remain application-local.

## Acceptance checks

1. `/mcp` without a bearer or with the retired direct OAuth bearer is rejected with `401`.
2. Missing `MCP_ACCESS_TOKEN` configuration fails closed with `503`.
3. Missing `DATABASE_CONFIG` fails closed with `503 database_config_not_configured` after Portal authentication succeeds.
4. A browser `Origin` is rejected because direct browser clients are unsupported.
5. Correct Portal bearer reaches MCP and the inbound Authorization value is absent from tool/domain handling.
6. Portal discovers all 13 current tools: five read tools, three Safe Write tools, and five Safe Admin/DDL tools.
7. `list_connections` reports dialect/read transport plus `writeEnabled`/`writeTransport` and `adminEnabled`/`adminTransport` without SQL URLs, credentials, or binding names.
8. Connections without `write` return `WRITE_NOT_CONFIGURED` from write tools.
9. Connections without `admin` return `ADMIN_NOT_CONFIGURED` from Admin tools.
10. READ / WRITE / ADMIN resolution never falls back to another credential or transport.
11. Direct SQL URLs never appear in MCP responses or logs.
12. Hyperdrive binding internals and database credentials never appear in MCP responses or logs.
13. Write row values, predicates, and generated parameter arrays are not logged.
14. Generated Admin DDL and credentials are not logged.
15. `query_read` still rejects write SQL.
16. UPDATE/DELETE above the configured affected-row maximum are rolled back with `WRITE_LIMIT_EXCEEDED`.
17. PostgreSQL writer RLS and reader RLS remain effective.
18. Reader identities cannot write or perform DDL; writer identities cannot perform DDL/admin operations or dangerous routines.
19. Bounded ADMIN identities can perform the supported schema lifecycle but cannot perform out-of-scope user/role/server administration.
20. `drop_table`, `drop_index`, and drop-column reject execution without explicit confirmation.
21. MySQL Safe Write uses transactional table engines when rollback guarantees are required.
22. Rate limiting continues to use the stable logical Portal principal.
23. Direct URLs requesting TLS are rejected during configuration parsing.

## Deployment boundary

Production deployment remains Cloudflare Builds. The target ingress policy is the Worker's `workers.dev` endpoint with `workers_dev:true`, `preview_urls:false`, and no required custom domain or zone route.

`wrangler.jsonc` declares `MCP_ACCESS_TOKEN` and `DATABASE_CONFIG` as required secret names. Their values remain environment-owned Runtime Secrets and are not committed to Git. Hyperdrive resource IDs/bindings remain Wrangler/Cloudflare bindings.

Direct mode is only for publicly reachable legacy databases where plaintext transport is explicitly acceptable. Private-network routing through Workers VPC or Cloudflare Tunnel is not part of the direct contract.
