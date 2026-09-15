# Cloudflare MCP Portal deployment

This deployment keeps client-facing authentication at Cloudflare MCP Portal and keeps the Raindrop API credential inside the Worker.

## Architecture

```text
MCP client
  -> Cloudflare MCP Portal
  -> Authorization: Bearer <MCP_ACCESS_TOKEN>
  -> raindrop-mcp Worker /mcp
  -> RAINDROP_ACCESS_TOKEN
  -> Raindrop.io API
```

The credentials are intentionally independent:

- `MCP_ACCESS_TOKEN` authenticates MCP Portal to this Worker. Each Worker uses its own value.
- `RAINDROP_ACCESS_TOKEN` authenticates this Worker to Raindrop.io.

Never reuse either value for the other purpose.

## 1. Configure Worker secrets

Create both Worker secrets in Cloudflare. The repository must never contain their real values.

```bash
pnpm exec wrangler secret put RAINDROP_ACCESS_TOKEN
pnpm exec wrangler secret put MCP_ACCESS_TOKEN
```

MCP Portal sends the Worker credential as:

```text
Authorization: Bearer <MCP_ACCESS_TOKEN>
```

The production Wrangler configuration keeps the existing Worker identity `raindrop-mcp`, disables `workers.dev` and Preview URLs, and preserves the current custom-domain production ingress.

## 2. Worker ingress contract

`GET /health` remains public for operational checks and does not read upstream state or secrets.

For `/mcp`:

- missing or invalid Portal bearer -> `401`
- missing Worker `MCP_ACCESS_TOKEN` configuration -> `503`
- request with an `Origin` header -> `403`
- missing `RAINDROP_ACCESS_TOKEN` after Portal authentication -> `503`
- unknown route -> `404`

The Worker has no direct browser-client requirement, so it does not expose a CORS policy and does not provide an `OPTIONS` preflight success path. Server-to-server requests without an `Origin` header are allowed after normal bearer authentication.

After successful Portal authentication, the shared `@mcp-workers/portal-auth` boundary removes the inbound `Authorization` header before the request reaches the MCP SDK or any Raindrop tool/service code.

## 3. Add the Worker as an MCP server in Portal

Register the existing production Worker `/mcp` URL as the upstream MCP server. Configure upstream authentication as Bearer and set its credential to the same value stored in this Worker's `MCP_ACCESS_TOKEN` secret.

Do not place `RAINDROP_ACCESS_TOKEN` in Portal. ChatGPT or another MCP client connects to the Portal URL, not to the raw Worker endpoint as a separate client-auth surface.

## 4. Acceptance checks

Validate in this order:

1. `GET /health` returns 200 and no secret material.
2. Direct `/mcp` without a bearer returns 401.
3. `/mcp` with a browser `Origin` returns 403 and no CORS headers.
4. Direct `/mcp` with the correct `MCP_ACCESS_TOKEN` reaches MCP transport.
5. Portal can discover the Raindrop server and its existing tools.
6. Run one read-only tool and confirm a successful Raindrop result.
7. Only after the read path is verified, run a write-capable tool and confirm the resulting change in Raindrop.
8. Check Worker logs and confirm no Portal bearer or `RAINDROP_ACCESS_TOKEN` value is logged.

## Compatibility probe

The Worker preserves one narrowly scoped compatibility exception: an authenticated empty `POST /mcp` with `Content-Type: application/octet-stream` and `Content-Length: 0` returns `204`.

This remains temporary client compatibility behavior, not a separate MCP transport. Normal MCP requests continue to be handled by the official MCP SDK.

## Cloudflare references

- MCP server portals: https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/
- Workers routing: https://developers.cloudflare.com/workers/configuration/routing/
- Worker Preview URLs: https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/
- Workers Logs: https://developers.cloudflare.com/workers/observability/logs/workers-logs/
