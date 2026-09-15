# Deployment

OpenList is migrating to Cloudflare MCP Portal with an expand/contract rollout. During the expand phase, the Worker accepts either the new Portal origin bearer or the existing Cloudflare Access assertion path. Do not remove the Access path until Portal acceptance checks pass.

## 1. Prepare OpenList

1. Deploy or identify an HTTPS-accessible OpenList v4 instance.
2. Create a dedicated low-privilege OpenList user/token with only the required Base Path and permissions.
3. Configure Worker vars: `OPENLIST_URL`, `OPENLIST_ALLOWED_PATHS`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`.
4. Store the business credential only in the Worker:

```sh
npx wrangler secret put OPENLIST_TOKEN
```

`OPENLIST_TOKEN` remains the raw/non-Bearer Worker-to-OpenList credential. Never reuse it as the Portal origin credential.

## 2. Add Portal origin authentication

Generate a separate high-entropy origin credential and store it in the Worker:

```sh
npx wrangler secret put MCP_ORIGIN_TOKEN
```

Deploy the Worker to the intended custom hostname. Keep `workers_dev=false` and Preview URLs disabled for production.

Register the full Worker MCP URL in Cloudflare MCP Portal:

```text
https://<openlist-worker-custom-domain>/mcp
```

Configure Portal upstream authentication as Bearer with the same value stored in `MCP_ORIGIN_TOKEN`.

Attach the upstream server to a Portal with Managed OAuth / Access restricted to the intended identity. Configure ChatGPT or another MCP client with the **Portal URL**, not the raw Worker URL.

## 3. Preserve the legacy Access path during expand

Keep the current Cloudflare Access application and `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` configuration until Portal cutover is verified. Requests with no Portal bearer continue through `Cf-Access-Jwt-Assertion` verification.

A request that explicitly presents an incorrect bearer credential is rejected and does not fall through to Access JWT verification.

## 4. Acceptance checks

Run in this order:

1. Direct `/mcp` without either accepted authentication path is rejected.
2. Direct `/mcp` with the correct `MCP_ORIGIN_TOKEN` reaches the MCP transport.
3. Existing Access JWT ingress still works during the expand phase.
4. Portal discovers the existing OpenList tool set.
5. With `OPENLIST_READONLY=true`, mutation tools remain absent from discovery.
6. Verify path allowlists with both an allowed and a denied path.
7. Execute one representative read tool through Portal.
8. Only after read-only verification, enable writes if needed and execute one bounded operation that already exists in the tool surface.
9. Inspect Worker logs/responses and confirm no client OAuth token, Access assertion, `MCP_ORIGIN_TOKEN`, or `OPENLIST_TOKEN` value is exposed.

## 5. Contract phase

Only after the checks above pass should the follow-up contract ticket remove Worker-side client Access JWT validation and its configuration. The path allowlist, read-only switch, destructive-operation guards, upload bounds, timeouts, and OpenList business authentication stay in the Worker.

Start with read-only mode. Set `OPENLIST_READONLY=false` only after read operations work and path restrictions have been verified.
