# Database MCP Portal authentication

Database MCP uses Cloudflare MCP Portal as the supported client-facing ingress. The previous direct JWT OAuth resource-server compatibility path has been retired.

## Architecture

```text
MCP client
  -> Cloudflare MCP Portal
  -> Authorization: Bearer <MCP_ACCESS_TOKEN>
  -> database MCP Worker /mcp
  -> Hyperdrive READ binding
  -> dedicated read-only database credential
  -> database-native GRANT / RLS / views / routine policy
```

`MCP_ACCESS_TOKEN` authenticates only Portal -> Worker. Hyperdrive/database credentials authenticate only Worker -> database. Never reuse either credential for the other purpose.

Store the Portal credential as this Worker's own secret:

```bash
pnpm exec wrangler secret put MCP_ACCESS_TOKEN
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

The original `docs/spec.md` describes the earlier v0.1 OAuth resource-server design and remains useful as historical/database-security design evidence; this document supersedes its client-authentication sections for the current monorepo target.

## Security boundaries retained

Portal-only ingress does **not** weaken database authorization:

1. The MCP tool surface remains read-only.
2. Each logical connection maps only to its READ Hyperdrive binding.
3. Hyperdrive uses a dedicated least-privilege database identity.
4. Database-native GRANTs, PostgreSQL RLS, restricted views, and routine/function permissions remain the authoritative data boundary.
5. SQL guardrails, result/row/time limits, rate limiting and sanitized logs remain application-local.

## Acceptance checks

1. `/mcp` without a bearer or with the retired direct OAuth bearer is rejected with `401`.
2. Missing `MCP_ACCESS_TOKEN` configuration fails closed with `503`.
3. A request carrying a browser `Origin` is rejected because the Worker has no direct browser-client requirement.
4. Correct Portal bearer reaches the MCP transport and the inbound Authorization value is absent from tool/domain handling.
5. Portal discovers the existing five read-only tools.
6. `list_connections` and `inspect_schema` work through Portal.
7. PostgreSQL and MySQL integration tests continue to use dedicated read-only credentials.
8. Unsafe/write SQL remains rejected by Worker guardrails and independently by database permissions.
9. PostgreSQL RLS/restricted views and MySQL least-privilege behavior remain unchanged.
10. Rate limiting still applies using the stable logical Portal principal.
11. Logs contain no Portal credential, Hyperdrive connection secret, SQL parameter value, or database password.

## Deployment boundary

Production deployment remains Cloudflare Builds only. Preserve the actual Worker name, Hyperdrive resource IDs, bindings and reachable route during cutover. Do not create a second production publisher. If no current production instance exists, this ticket only establishes the target code/config contract; deployment is handled by the later acceptance/cutover work.
