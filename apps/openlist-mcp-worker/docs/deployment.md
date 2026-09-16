# Deployment

OpenList uses Cloudflare MCP Portal as the supported client-facing ingress for this Worker. Worker-side Cloudflare Access JWT client authentication has been retired.

## 1. Prepare OpenList

1. Deploy or identify an HTTPS-accessible OpenList v4 instance.
2. Create a dedicated low-privilege OpenList user/token with only the required base path and permissions.
3. Configure `OPENLIST_URL` and any optional read-only/upload/timeout settings.
4. Leave `OPENLIST_ALLOWED_PATHS` unset to allow `/` by default, or set a comma-separated allowlist such as `/documents,/backup` for an additional Worker-side restriction.
5. Store `OPENLIST_TOKEN` as the Worker-to-OpenList business secret.
6. Store a separate high-entropy `MCP_ACCESS_TOKEN` for Portal-to-Worker authentication.

Never reuse either secret for the other role or share this Worker's access token with another Worker.

## 2. Worker ingress

The monorepo target uses the stable workers.dev origin:

```text
https://openlist-mcp-worker.<workers-subdomain>.workers.dev/mcp
```

`wrangler.jsonc` must keep `workers_dev:true` and `preview_urls:false`. Register that `/mcp` URL in Cloudflare MCP Portal and configure upstream authentication as Bearer with the same value stored in Worker secret `MCP_ACCESS_TOKEN`.

For `/mcp`:

- missing/invalid Portal bearer -> `401`;
- missing `MCP_ACCESS_TOKEN` configuration -> `503`;
- browser `Origin` header -> `403`;
- valid Portal bearer -> inbound `Authorization` is consumed before MCP/domain handling;
- a retired Access assertion alone does not authorize the request.

`OPENLIST_TOKEN`, optional path allowlists, read-only mode, destructive-operation confirmation, upload bounds, and timeouts remain separate controls. When `OPENLIST_ALLOWED_PATHS` is unset or blank, it defaults to `/`, so effective path access is bounded by the OpenList account/token permissions.

## 3. Acceptance

Run in this order:

1. `GET /health` succeeds without contacting OpenList.
2. Direct `/mcp` without bearer returns `401`.
3. Browser-origin `/mcp` returns `403`.
4. Correct `MCP_ACCESS_TOKEN` reaches the MCP transport and is not forwarded to OpenList.
5. Portal discovers the expected tool set.
6. With `OPENLIST_READONLY=true`, mutation tools are absent.
7. With `OPENLIST_ALLOWED_PATHS` omitted, verify a normal path accessible to the OpenList account works. If an explicit allowlist is configured, also verify one allowed and one denied path.
8. Execute one explicitly selected safe/read-only tool through Portal.
9. Inspect logs/responses and confirm no Portal bearer or `OPENLIST_TOKEN` is exposed.

Only enable writes after the read-only path and any configured path restrictions have been verified.

## Production cutover boundary

This repository configuration does not itself authorize replacing the separately operating OpenList Tunnel/local-service topology. Until a dedicated final cutover is executed and verified, the existing production service remains operationally separate from this Worker target.
