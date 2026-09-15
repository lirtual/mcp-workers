# Cloudflare MCP Portal migration

This repository uses an expand/contract migration. During **expand**, Cloudflare MCP Portal can authenticate to `/mcp` with a dedicated origin bearer while the existing JWT OAuth resource-server path remains available for rollback.

## Expand architecture

```text
MCP client
  -> Cloudflare MCP Portal + Managed OAuth / Access
  -> Authorization: Bearer <MCP_ORIGIN_TOKEN>
  -> database MCP Worker /mcp
  -> Hyperdrive READ binding
  -> dedicated read-only database credential
  -> database-native GRANT / RLS / views / routine policy
```

The legacy direct OAuth resource-server path remains usable until the contract ticket is approved:

```text
MCP client -> JWT bearer -> database MCP Worker /mcp
```

## Credential boundaries

Keep these identities independent:

1. Client identity is enforced by MCP Portal / Access.
2. `MCP_ORIGIN_TOKEN` authenticates only Portal -> Worker.
3. Hyperdrive/database credentials authenticate only Worker -> database.

Store the origin credential as a Worker secret:

```bash
npx wrangler secret put MCP_ORIGIN_TOKEN
```

Never put a database password in MCP Portal and never reuse the Portal origin bearer as a database credential.

## Portal principal and rate limiting

The existing tool layer requires an authenticated `clientId` for audit hashing and rate limiting. The legacy JWT path keeps its existing per-token subject. The Portal fixed-origin path supplies the stable synthetic principal `cloudflare-mcp-portal` and the configured read scope without exposing the origin secret in `authInfo`.

This preserves the rate-limit and audit seams during expand. If a future multi-user deployment requires per-user rate limiting inside the Worker, that must use a verified Portal identity propagation mechanism rather than forwarding the client OAuth bearer as a business credential.

## Origin hardening

The production Worker example disables `workers.dev` and Preview URLs. Configure a production custom hostname reachable by Cloudflare MCP Portal and register its full `/mcp` URL as the upstream server.

Configure Portal upstream authentication as Bearer using `MCP_ORIGIN_TOKEN`. Configure ChatGPT or another MCP client with the **Portal URL**, not the raw Worker hostname.

## Acceptance checks

Run these before any contract-phase deletion:

1. A request using `MCP_ORIGIN_TOKEN` reaches the MCP transport and the incoming Authorization header is not exposed to tools.
2. The existing JWT bearer resource-server path still works.
3. Portal discovers the five existing read-only tools.
4. `list_connections` and `inspect_schema` succeed through Portal.
5. Representative PostgreSQL and MySQL reads remain bounded and use dedicated read-only credentials.
6. Unsafe/write SQL remains rejected by Worker guardrails and, independently, by database permissions.
7. PostgreSQL RLS / restricted views and MySQL least-privilege behavior remain unchanged.
8. Rate limiting still applies to Portal traffic using the stable Portal principal.
9. Logs contain no client token, `MCP_ORIGIN_TOKEN`, Hyperdrive connection secret, SQL parameter values, or database password.

## Contract phase

Only after the checks above succeed should the follow-up contract ticket remove Worker-owned protected-resource metadata, JWKS verification, and client OAuth issuer/audience configuration. Hyperdrive routing, rate limiting, SQL guardrails, result bounds, read-only credentials, and database-native authorization are explicitly retained.
