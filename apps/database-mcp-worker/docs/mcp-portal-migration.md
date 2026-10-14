# Database MCP Portal authentication

Database MCP uses Cloudflare MCP Portal as the supported client-facing ingress. The previous direct JWT OAuth resource-server compatibility path has been retired.

## Architecture

```text
MCP client
  -> Cloudflare MCP Portal
  -> Authorization: Bearer <MCP_ACCESS_TOKEN>
  -> database MCP Worker /mcp
  -> DATABASE_CONFIG (flat id -> SQL URL or Hyperdrive reference)
  -> selected logical connection and one database principal
  -> database-native privileges / RLS / ownership / policy
```

`MCP_ACCESS_TOKEN` authenticates only Portal -> Worker. Database credentials live only inside the `DATABASE_CONFIG` Runtime Secret for direct mode, or inside Cloudflare Hyperdrive for supported Hyperdrive paths. Never reuse the Portal token as a database credential.

Store the Portal credential and database catalog as Worker Runtime Secrets:

```bash
pnpm --filter database-mcp-worker exec wrangler secret put MCP_ACCESS_TOKEN
pnpm --filter database-mcp-worker exec wrangler secret put DATABASE_CONFIG
```

The Worker consumes the inbound Portal `Authorization` header before MCP/tool handling. Tools receive only a non-secret logical principal (`cloudflare-mcp-portal`) with logical `db:read` / `db:write` / `db:admin` capability metadata. The real Portal credential is never forwarded to database code.

The connection id selects one database principal. Native grants and ownership decide which reads, structured writes, and DDL that principal can perform. The Worker never promotes credentials or adds a privilege layer.

Structured DDL is direct-only in v0.3. A selected Hyperdrive connection fails closed with `ADMIN_OPERATION_NOT_SUPPORTED`; there is no automatic transport fallback.

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

1. Each logical connection ID maps directly to one SQL URL or strict Hyperdrive reference.
2. One configured connection allows omitted `connection`; multiple connections require an explicit ID.
3. No READ / WRITE / ADMIN credential or transport fallback occurs.
4. Hyperdrive DDL fails closed in v0.3.
5. Direct credentials remain inside the `DATABASE_CONFIG` Runtime Secret; they are never exposed through ordinary text vars or MCP results.
6. Database-native privileges, PostgreSQL RLS/ownership, restricted views, and routine/function permissions remain authoritative.
7. `query_read` stays read-only; Safe Write accepts structured data/predicates instead of raw write SQL.
8. Safe Admin accepts structured DDL inputs only; arbitrary DDL/admin SQL is not exposed.
9. Destructive risk is reported through MCP annotations; DDL is never automatically retried after ambiguous execution.
10. UPDATE/DELETE retain the affected-row rollback guard in addition to database query timeouts.
11. Rate limiting and sanitized observability remain application-local.

## Acceptance checks

1. `/mcp` without a bearer or with the retired direct OAuth bearer is rejected with `401`.
2. Missing `MCP_ACCESS_TOKEN` configuration fails closed with `503`.
3. Missing `DATABASE_CONFIG` fails closed with `503 database_config_not_configured` after Portal authentication succeeds.
4. A browser `Origin` is rejected because direct browser clients are unsupported.
5. Correct Portal bearer reaches MCP and the inbound Authorization value is absent from tool/domain handling.
6. Portal discovers all 13 current tools: five read tools, three Safe Write tools, and five Safe Admin/DDL tools.
7. `list_connections` reports only ID, dialect, and transport without SQL URLs, credentials, or binding names.
8. One connection permits omitted `connection`; multiple connections reject omission; unknown explicit IDs fail closed.
9. Reads, structured writes, and direct DDL resolve the same configured principal.
10. Hyperdrive DDL fails closed with `ADMIN_OPERATION_NOT_SUPPORTED` and has no fallback.
11. Direct SQL URLs never appear in MCP responses or logs.
12. Hyperdrive binding internals and database credentials never appear in MCP responses or logs.
14. Write row values, predicates, and generated parameter arrays are not logged.
15. Generated Admin DDL and credentials are not logged.
16. `query_read` still rejects write SQL.
17. UPDATE/DELETE above the configured affected-row maximum are rolled back with `WRITE_LIMIT_EXCEEDED`.
18. PostgreSQL RLS remains effective for the selected connection principal.
19. A read-only database principal cannot mutate data; a principal with the required native grants can use the corresponding structured operations.
20. DDL succeeds only where the selected principal has database-native privileges or ownership; no extra elevated identity is used.
21. Destructive DDL tools expose accurate risk annotations and target inputs.
22. MySQL Safe Write uses transactional table engines when rollback guarantees are required.
23. Rate limiting continues to use the stable logical Portal principal.
24. Direct URLs requesting TLS are rejected during configuration parsing.

## Deployment boundary

Production deployment remains Cloudflare Builds. The target ingress policy is the Worker's `workers.dev` endpoint with `workers_dev:true`, `preview_urls:false`, and no required custom domain or zone route.

`wrangler.jsonc` declares `MCP_ACCESS_TOKEN` and `DATABASE_CONFIG` as required secret names. Their values remain environment-owned Runtime Secrets and are not committed to Git. Hyperdrive resource IDs/bindings remain Wrangler/Cloudflare bindings.

Direct mode is only for publicly reachable legacy databases where plaintext transport is explicitly acceptable. Private-network routing through Workers VPC or Cloudflare Tunnel is not part of the direct contract.
