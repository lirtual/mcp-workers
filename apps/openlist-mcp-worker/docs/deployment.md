# Deployment

OpenList uses Cloudflare MCP Portal as the supported client-facing ingress for this Worker. Worker-side Cloudflare Access JWT client authentication has been retired.

## 1. Prepare OpenList

1. Deploy or identify an HTTPS-accessible OpenList v4 instance.
2. Create a dedicated low-privilege OpenList user/token with only the required Base Path and permissions.
3. Configure non-secret Worker vars `OPENLIST_URL` and `OPENLIST_ALLOWED_PATHS` plus any optional read-only/upload/timeout settings.
4. Store the OpenList business credential only in the Worker:

```sh
pnpm exec wrangler secret put OPENLIST_TOKEN
```

`OPENLIST_TOKEN` remains the raw/non-Bearer Worker-to-OpenList credential.

## 2. Configure Portal-to-Worker authentication

Generate a separate high-entropy credential for this Worker and store it as:

```sh
pnpm exec wrangler secret put MCP_ACCESS_TOKEN
```

Do not reuse this value for another Worker or as the OpenList token.

Keep the existing Worker identity and routing. `workers_dev=false` remains intentional for this app unless its separately managed production routing is explicitly changed.

Register the full Worker MCP URL in Cloudflare MCP Portal and configure upstream authentication as Bearer using the same value stored in this Worker's `MCP_ACCESS_TOKEN` secret.

ChatGPT or another MCP client connects to the **Portal URL**, not to the raw Worker as a second client-auth surface.

## 3. Worker ingress contract

For `/mcp`:

- missing or invalid Portal bearer -> `401`
- missing `MCP_ACCESS_TOKEN` configuration -> `503`
- request with an `Origin` header -> `403` because this Worker has no direct browser-client requirement
- valid Portal bearer -> the inbound `Authorization` header is removed before MCP/domain handling
- retired `Cf-Access-Jwt-Assertion` alone does not authorize the request

`CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` are no longer Worker runtime requirements.

The path allowlist, read-only switch, destructive-operation guards, upload bounds, timeouts, and `OPENLIST_TOKEN` business authentication remain unchanged.

## 4. Acceptance checks

Run in this order:

1. `GET /health` succeeds without calling OpenList.
2. Direct `/mcp` without a bearer returns `401`.
3. Direct `/mcp` with a browser `Origin` returns `403`.
4. Correct `MCP_ACCESS_TOKEN` reaches the MCP transport and the entry credential is not forwarded into OpenList handling.
5. A legacy Access assertion without the Portal bearer is rejected.
6. Portal discovers the existing OpenList tool set.
7. With `OPENLIST_READONLY=true`, mutation tools remain absent from discovery.
8. Verify path allowlists with both an allowed and a denied path.
9. Execute one representative read tool through Portal.
10. Only after read-only verification, enable writes if needed and execute one bounded operation already present in the tool surface.
11. Inspect Worker logs/responses and confirm no Portal bearer or `OPENLIST_TOKEN` value is exposed.

Start with read-only mode. Set `OPENLIST_READONLY=false` only after read operations work and path restrictions have been verified.

## Production-topology note

The monorepo migration does not by itself authorize replacing any separately operating OpenList Tunnel/service topology. A Worker deployment/cutover is a distinct operational action and must preserve the actually used Portal upstream until explicitly validated.
