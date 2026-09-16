# Database MCP Portal authentication

Database MCP uses Cloudflare MCP Portal as the supported client-facing ingress. The Worker keeps one Portal-to-Worker bearer credential while database READ and optional WRITE credentials remain separate runtime concerns.

## Architecture

```text
MCP client
  -> Cloudflare MCP Portal
  -> Authorization: Bearer <MCP_ACCESS_TOKEN>
  -> database-mcp-worker /mcp
  -> static logical connection
       -> READ transport  -> read-only database credential
       -> optional WRITE transport -> limited writer credential
  -> database-native GRANT / RLS / views / routine policy
```

`MCP_ACCESS_TOKEN` authenticates only Portal -> Worker. Database credentials authenticate only Worker -> database. Never reuse one credential for another role.

Store the Portal credential as this Worker's own Secret:

```bash
pnpm --filter database-mcp-worker exec wrangler secret put MCP_ACCESS_TOKEN
```

The Worker consumes the inbound `Authorization` header before MCP/tool handling. Tools receive only a stable logical principal. The logical AuthInfo advertises `db:read` and `db:write`; these scopes are capability metadata, not the final database authorization boundary.

## Supported MCP surface

Portal should discover eight tools:

Read:

- `list_connections`
- `inspect_schema`
- `query_read`
- `explain`
- `health_check`

Safe Write:

- `insert_rows`
- `update_rows`
- `delete_rows`

Write tools never accept raw write SQL. A logical connection is writable only when its static catalog entry contains an explicit `write` configuration.

## Retired client OAuth surface

The Worker does not own a direct client OAuth resource-server path. These runtime requirements remain retired:

- protected-resource metadata endpoint
- JWT/JWKS access-token verification
- `OAUTH_ISSUER`
- `OAUTH_AUDIENCE`
- `OAUTH_JWKS_URL`
- `OAUTH_REQUIRED_SCOPE`
- `MCP_ORIGIN_TOKEN`

Git history preserves the earlier OAuth design when historical investigation is needed.

## Security boundaries

Portal-only ingress does not replace database authorization:

1. READ tools resolve only the configured READ transport and credential.
2. WRITE tools resolve only the optional WRITE transport and credential.
3. Missing writer configuration fails with `WRITE_NOT_CONFIGURED`; missing writer runtime resources fail closed and never fall back to READ.
4. Direct READ/WRITE URLs remain Worker Secrets and follow the plaintext legacy compatibility contract.
5. Hyperdrive READ/WRITE bindings are separately configured and should use separate database identities.
6. Structured writes generate parameterized SQL internally; raw write SQL, DDL and routine execution are outside the MCP surface.
7. UPDATE/DELETE use explicit transactions and roll back when affected rows exceed the configured safety limit.
8. PostgreSQL RLS and database-native GRANTs/routine permissions remain authoritative for writer identities.
9. SQL guardrails, result/write limits, rate limiting and sanitized logs remain application-local safety layers.

## Acceptance checks

1. `/mcp` without a bearer or with an incorrect bearer returns `401`.
2. Missing `MCP_ACCESS_TOKEN` fails closed with `503`.
3. A browser `Origin` is rejected because the Worker has no direct browser-client requirement.
4. Correct Portal bearer reaches MCP handling and the real bearer value is absent from tool/domain handling.
5. Portal discovers all eight expected tools.
6. `list_connections` exposes `writeEnabled`/`writeTransport` only as non-secret capability metadata.
7. Existing read tools continue using the read credential and still reject raw write SQL through `query_read`.
8. A read-only logical connection rejects write tools with `WRITE_NOT_CONFIGURED`.
9. `insert_rows` performs parameterized row inserts only through the writer credential.
10. `update_rows` and `delete_rows` reject empty/unsupported predicates and roll back when the affected-row limit is exceeded.
11. Direct SQL URLs, Hyperdrive binding internals, usernames/passwords, row values and predicate values are absent from MCP responses and logs.
12. PostgreSQL writer RLS is enforced.
13. Reader credentials cannot write; writer credentials cannot perform DDL/admin/routine operations beyond their database grants.
14. PostgreSQL and MySQL real-database integration remains green.
15. Rate limiting still uses the stable logical Portal principal and logical connection id.

## Deployment boundary

Production deployment remains Cloudflare Builds. The target ingress is the Worker's `workers.dev` endpoint with `workers_dev:true`, `preview_urls:false`, and no second production publisher.

For each writable logical connection, preserve both credential paths independently:

- Direct: separate READ and WRITE SQL URL Secrets.
- Hyperdrive: separate READ and WRITE bindings backed by least-privilege database identities.

`keep_vars:true` preserves Dashboard-managed plain-text variables, but Secrets and bindings remain environment-owned runtime configuration.

Direct Safe Write is intended only for publicly reachable legacy databases where plaintext transport is explicitly acceptable. MySQL rollback protection requires transactional tables such as InnoDB. Private-network VPC/Tunnel work remains outside v0.2.

Before production enablement, smoke-test the deployed READ and WRITE paths against a non-production or tightly scoped dataset. CI verifies direct PostgreSQL/MySQL Safe Write behavior; real Hyperdrive writer bindings still require Cloudflare staging verification.
