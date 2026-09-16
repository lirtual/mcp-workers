# Database MCP Portal authentication

Database MCP uses Cloudflare MCP Portal as the supported client-facing ingress. The previous direct JWT OAuth resource-server compatibility path has been retired.

## Architecture

```text
MCP client
  -> Cloudflare MCP Portal
  -> Authorization: Bearer <MCP_ACCESS_TOKEN>
  -> database MCP Worker /mcp
  -> static logical connection
       -> Hyperdrive READ binding
       -> direct SQL URL Worker Secret
  -> dedicated read-only database credential
  -> database-native GRANT / RLS / views / routine policy
```

`MCP_ACCESS_TOKEN` authenticates only Portal -> Worker. Database credentials authenticate only Worker -> database. Never reuse either credential for the other purpose.

Store the Portal credential as this Worker's own secret:

```bash
pnpm --filter database-mcp-worker exec wrangler secret put MCP_ACCESS_TOKEN
```

The Worker consumes the inbound Portal `Authorization` header before MCP/tool handling. Tools receive only a non-secret logical principal (`cloudflare-mcp-portal`) with the logical `db:read` scope, preserving the existing audit/rate-limit context without forwarding the real Portal credential.

## Retired client OAuth surface

The Worker no longer owns a direct client OAuth resource-server path. These runtime requirements are retired:

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

1. The MCP tool surface remains read-only.
2. Each logical connection selects exactly one explicit `direct` or `hyperdrive` transport.
3. Hyperdrive connections use a dedicated least-privilege database identity behind a cache-disabled Hyperdrive binding.
4. Direct connections read exactly one SQL URL from a named Worker Secret and are plaintext-only in v0.1.
5. Database-native GRANTs, PostgreSQL RLS, restricted views, and routine/function permissions remain the authoritative data boundary.
6. SQL guardrails, result/row/time limits, rate limiting and sanitized logs remain application-local.
7. No transport automatically falls back to the other.

## Acceptance checks

1. `/mcp` without a bearer or with the retired direct OAuth bearer is rejected with `401`.
2. Missing `MCP_ACCESS_TOKEN` configuration fails closed with `503`.
3. A request carrying a browser `Origin` is rejected because the Worker has no direct browser-client requirement.
4. Correct Portal bearer reaches the MCP transport and the inbound Authorization value is absent from tool/domain handling.
5. Portal discovers the existing five read-only tools.
6. `list_connections` reports non-secret logical metadata including resolved dialect and transport.
7. `inspect_schema`, `query_read`, `explain`, and `health_check` work for every advertised transport/dialect path.
8. Direct SQL URLs never appear in MCP responses or logs.
9. Hyperdrive binding internals and database credentials never appear in MCP responses or logs.
10. Unsafe/write SQL remains rejected by Worker guardrails and independently by database permissions.
11. PostgreSQL RLS/restricted views and MySQL least-privilege behavior remain unchanged.
12. Rate limiting still applies using the stable logical Portal principal.
13. Hyperdrive failures do not fall back to direct.
14. Direct URLs that request TLS are rejected during connection resolution.

## Deployment boundary

Production deployment remains Cloudflare Builds only. The target ingress policy is the Worker's `workers.dev` endpoint with `workers_dev:true`, `preview_urls:false`, and no custom domain or zone route.

Preserve each configured Hyperdrive resource ID/binding and every direct database URL Secret during deployment. `keep_vars:true` preserves Dashboard-managed plain-text variables, but Secrets and bindings are still environment-owned runtime configuration.

Direct mode is only for publicly reachable legacy databases where plaintext transport is explicitly acceptable. Private-network routing through Workers VPC or Cloudflare Tunnel is not part of the v0.1 direct contract.

If no current production instance exists, this document only establishes the target code/config contract; deployment is handled by later acceptance/cutover work.
