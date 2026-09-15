# Cloudflare MCP Portal deployment

This deployment keeps client-facing OAuth at Cloudflare and keeps the Raindrop API credential inside the Worker.

## Architecture

```text
MCP client
  -> Cloudflare MCP Portal + Managed OAuth
  -> Authorization: Bearer <MCP_ORIGIN_TOKEN>
  -> raindrop-mcp Worker /mcp
  -> RAINDROP_ACCESS_TOKEN
  -> Raindrop.io API
```

The two credentials are intentionally independent:

- `MCP_ORIGIN_TOKEN` authenticates the trusted Cloudflare MCP Portal to the Worker origin.
- `RAINDROP_ACCESS_TOKEN` authenticates the Worker to Raindrop.io.

Never reuse either value for the other purpose.

## 1. Configure Worker secrets

Create both Worker secrets in Cloudflare. The repository must never contain their real values.

```bash
bunx wrangler secret put RAINDROP_ACCESS_TOKEN
bunx wrangler secret put MCP_ORIGIN_TOKEN
```

Generate `MCP_ORIGIN_TOKEN` as a high-entropy random value. The Worker expects it as a standard bearer credential:

```text
Authorization: Bearer <MCP_ORIGIN_TOKEN>
```

The production Wrangler configuration disables the default `workers.dev` route, Preview URLs, and invocation logs. Keep a Worker custom domain available for Cloudflare MCP Portal to reach the backend. Application logs remain enabled for fixed auth/protocol diagnostics and must never contain secret values.

## 2. Verify the Worker origin

`GET /health` remains public for operational checks.

A direct request to `/mcp` without the bearer origin credential must return `401 Unauthorized`.

If `MCP_ORIGIN_TOKEN` is not configured at all, `/mcp` fails closed with a server configuration error. If `RAINDROP_ACCESS_TOKEN` is absent, an authenticated `/mcp` request also fails closed before tool execution.

After successful origin authentication, the Worker removes the `Authorization` header before the request is handed to the MCP SDK. The Portal-to-origin secret is therefore not exposed to MCP tools or service code.

## 3. Add the Worker as an MCP server in Cloudflare

In Cloudflare Zero Trust, add the Worker MCP URL as an upstream MCP server. Use the full MCP URL, for example:

```text
https://<worker-custom-domain>/mcp
```

Configure the upstream authentication as **Bearer** and set the bearer credential to the same value stored in `MCP_ORIGIN_TOKEN`.

Cloudflare MCP Portal sends a raw bearer credential as `Authorization: Bearer <token>` to the upstream MCP server. Do not place the Raindrop Test Token in the Portal.

If configuring the server through the Cloudflare API, the relevant contract is conceptually:

```json
{
  "auth_type": "bearer",
  "auth_credentials": "<same value as MCP_ORIGIN_TOKEN>"
}
```

## 4. Create the MCP Portal

Create a Cloudflare MCP Portal, attach the Raindrop MCP server, and add an Access policy that permits only the intended user/account.

Enable Managed OAuth on the portal. New portals may have Managed OAuth enabled by default, but verify the setting explicitly before connecting an MCP client.

The URL given to ChatGPT or another MCP client must be the Portal URL, not the raw Worker origin URL.

## 5. Acceptance checks

Validate in this order:

1. `GET /health` on the Worker returns healthy.
2. Direct `/mcp` without the bearer origin credential returns `401`.
3. Direct `/mcp` with `Authorization: Bearer <MCP_ORIGIN_TOKEN>` reaches the MCP transport.
4. The Portal can discover the Raindrop server and its tools.
5. The MCP client completes Managed OAuth against the Portal.
6. The client can enumerate Raindrop tools through the Portal.
7. Run one read-only tool and confirm a successful Raindrop result.
8. Only after the read path is verified, run a write-capable tool and confirm the resulting change in Raindrop.
9. Check Worker application logs and confirm no OAuth bearer token, `MCP_ORIGIN_TOKEN`, or `RAINDROP_ACCESS_TOKEN` value is logged.

## Compatibility probe

The Worker currently preserves one narrowly scoped compatibility exception: an authenticated empty `POST /mcp` with `Content-Type: application/octet-stream` and `Content-Length: 0` returns `204`.

This is temporary client compatibility behavior, not a private MCP transport. Normal MCP requests continue to be handled by the official MCP SDK. Re-test whether this exception is still needed after the Portal path is working end to end.

## Gateway fallback

`cloudflare_gateway` is not required in the normal Portal path. Use it only when an MCP backend needs behavior that Cloudflare MCP Portal cannot provide, such as unusual path rewrites, body transforms, or nonstandard upstream authentication.

If Gateway is introduced later, consume client authentication at Gateway and keep upstream authentication as a separate credential. Never forward a client OAuth bearer token as the Raindrop API token.

## Cloudflare references

- MCP server portals: https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/
- Managed OAuth: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/
- Worker `workers.dev` configuration: https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
- Worker Preview URLs: https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/
- Workers Logs: https://developers.cloudflare.com/workers/observability/logs/workers-logs/
