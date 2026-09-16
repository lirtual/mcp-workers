# Database MCP Portal authentication

Database MCP uses Cloudflare MCP Portal as the supported client-facing ingress. The previous direct JWT OAuth resource-server compatibility path has been retired.

## Architecture

```text
MCP client
  -> Cloudflare MCP Portal
  -> Authorization: Bearer <MCP_ACCESS_TOKEN>
  -> database MCP Worker /mcp
  -> static logical connection
       -> READ  -> Hyperdrive binding or direct SQL URL Secret
       -> WRITE -> optional separate Hyperdrive binding or direct SQL URL Secret
  -> least-privilege database identities
  -> database-native GRANT / RLS / views / routine policy
```

`MCP_ACCESS_TOKEN` authenticates only Portal -> Worker. Database credentials authenticate only Worker -> database. Never reuse either credential for the other purpose.

Store the Portal credential as this Worker's own secret:

```bash
pnpm --filter database-mcp-worker exec wrangler secret put MCP_ACCESS_TOKEN
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
5. Direct read/write paths each read one complete SQL URL from a named Worker Secret and remain plaintext-only in v0.2.
6. Database-native GRANTs, PostgreSQL RLS, restricted views, and routine/function permissions remain authoritative.
7. `query_read` stays read-only; write tools accept structured data/predicates instead of raw write SQL.
8. UPDATE/DELETE use an affected-row rollback guard in addition to database query timeouts.
9. Rate limiting and sanitized observability remain application-local.

## Acceptance checks

1. `/mcp` without a bearer or with the retired direct OAuth bearer is rejected with `401`.
2. Missing `MCP_ACCESS_TOKEN` configuration fails closed with `503`.
3. A browser `Origin` is rejected because direct browser clients are unsupported.
4. Correct Portal bearer reaches MCP and the inbound Authorization value is absent from tool/domain handling.
5. Portal discovers the five existing read tools plus `insert_rows`, `update_rows`, and `delete_rows`.
6. `list_connections` reports dialect/read transport plus `writeEnabled` and optional `writeTransport`, without Secret/binding names.
7. Connections without `write` remain read-only and return `WRITE_NOT_CONFIGURED` from write tools.
8. Writer resolution never falls back to read credentials or another transport.
9. Direct read/write SQL URLs never appear in MCP responses or logs.
10. Hyperdrive binding internals and database credentials never appear in MCP responses or logs.
11. Write row values, predicates, and generated parameter arrays are not logged.
12. `query_read` still rejects write SQL.
13. UPDATE/DELETE that exceed the configured affected-row maximum are rolled back and return `WRITE_LIMIT_EXCEEDED`.
14. PostgreSQL writer RLS and reader RLS remain effective.
15. Reader identities still cannot write; writer identities still cannot perform DDL/admin operations or execute dangerous routines.
16. MySQL Safe Write is used only with transactional table engines when rollback guarantees are required.
17. Rate limiting continues to use the stable logical Portal principal.
18. Direct URLs requesting TLS are rejected during connection resolution.

## Deployment boundary

Production deployment remains Cloudflare Builds. The target ingress policy is the Worker's `workers.dev` endpoint with `workers_dev:true`, `preview_urls:false`, and no required custom domain or zone route.

Preserve each configured read/write Hyperdrive resource ID/binding and each direct database URL Secret during deployment. `keep_vars:true` preserves Dashboard-managed plain-text variables; Secrets and bindings remain environment-owned runtime configuration.

Direct mode is only for publicly reachable legacy databases where plaintext transport is explicitly acceptable. Private-network routing through Workers VPC or Cloudflare Tunnel is not part of the v0.2 direct contract.

If no current production instance exists, this document establishes the target code/config contract only; production binding/Secret setup and Portal smoke tests remain deployment actions.
