# instapaper-mcp-worker

A focused **Cloudflare Worker-only** MCP server for Instapaper.

## Architecture

- MCP SDK v2 (`@modelcontextprotocol/server`)
- Stateless Streamable HTTP at `/mcp`
- Cloudflare MCP Portal as the client-facing ingress
- Dedicated per-Worker `MCP_ACCESS_TOKEN` for Portal-to-Worker authentication
- Shared `@mcp-workers/portal-auth` ingress validation
- Instapaper Full API via OAuth 1.0a / HMAC-SHA1
- Instapaper credentials stay inside the Worker

```text
MCP client
  -> Cloudflare MCP Portal
  -> Authorization: Bearer <MCP_ACCESS_TOKEN>
  -> instapaper-mcp-worker /mcp
  -> Instapaper OAuth 1.0a credentials
  -> Instapaper API
```

The Worker validates the Portal credential and removes the inbound `Authorization` header before the request reaches the MCP SDK or Instapaper domain code. Requests without an `Origin` header are allowed for server-to-server use. Because this Worker has no direct browser use case, requests that contain an `Origin` header are rejected.

## Tools

1. `list_bookmarks`
2. `get_article_content`
3. `add_bookmark`
4. `set_bookmark_starred`
5. `set_bookmark_archived`
6. `move_bookmark`
7. `delete_bookmark`
8. `list_folders`
9. `create_folder`
10. `list_highlights`
11. `add_highlight`

## Prerequisites

- Node.js 24+
- Cloudflare Workers and MCP Portal
- Instapaper Full API consumer key/secret
- Wrangler authenticated with Cloudflare when using automatic secret setup

## Install

From the monorepo root:

```bash
pnpm install --frozen-lockfile
```

## Bootstrap Instapaper OAuth tokens

Run from this app directory or through the workspace filter.

### Automatic Cloudflare setup

Authenticate Wrangler, then run:

```bash
npx wrangler login
pnpm run setup:instapaper
```

The helper checks Cloudflare authentication before requesting Instapaper credentials. It performs Instapaper xAuth, verifies the returned token, and writes these Worker secrets with Wrangler:

- `INSTAPAPER_CONSUMER_KEY`
- `INSTAPAPER_CONSUMER_SECRET`
- `INSTAPAPER_OAUTH_TOKEN`
- `INSTAPAPER_OAUTH_TOKEN_SECRET`

### Manual Cloudflare Dashboard setup

For a headless environment or manual Dashboard configuration, run:

```bash
pnpm run setup:instapaper -- --manual
```

After xAuth and credential verification, the helper writes the four values to:

```text
.dev.vars.instapaper
```

The file is created with `0600` permissions and is covered by this app's `.gitignore`. Copy each value into **Workers & Pages → instapaper-mcp-worker → Settings → Variables and Secrets** as a Secret, then delete the local file:

```bash
rm .dev.vars.instapaper
```

The Instapaper username/password are used only during bootstrap and are not persisted. These OAuth credentials are upstream business credentials and are intentionally separate from MCP ingress authentication.

## Configure Portal-to-Worker authentication

Create this Worker's dedicated Portal access secret:

```bash
pnpm exec wrangler secret put MCP_ACCESS_TOKEN
```

Alternatively, generate a value locally and add it manually in the Cloudflare Dashboard:

```bash
openssl rand -hex 32
```

Configure the Instapaper server in MCP Portal to send the same value as its upstream bearer credential:

```text
Authorization: Bearer <MCP_ACCESS_TOKEN>
```

Do not reuse any Instapaper OAuth credential for this value, and do not reuse this Worker's access token for another Worker.

## Deploy

The monorepo ingress policy is authoritative: `wrangler.jsonc` enables the stable `workers.dev` origin and disables preview URLs. The Worker origin is therefore shaped as:

```text
https://instapaper-mcp-worker.<workers-subdomain>.workers.dev
```

Configure MCP Portal with the Worker's `/mcp` endpoint. ChatGPT or another MCP client connects through the **Portal URL**, not by treating the raw Worker endpoint as a separate client-auth surface.

## Development and verification

```bash
pnpm run typecheck
pnpm test
pnpm run deploy:dry-run
pnpm run check
```

Repository CI is owned by the monorepo root workflow; this app does not maintain a separate nested GitHub Actions pipeline.

## Security model

- Cloudflare MCP Portal owns client-facing authentication.
- `MCP_ACCESS_TOKEN` authenticates only Portal-to-Worker traffic.
- Instapaper OAuth credentials authenticate only Worker-to-Instapaper traffic.
- The Portal bearer is removed before MCP/domain processing.
- Browser-origin requests are rejected because no direct browser client is supported.
- Instapaper username/password are bootstrap-only.
- Secrets and local environment files are ignored by Git.
- `delete_bookmark` is marked destructive; read tools are marked read-only.

## Notes

This app is a cleaned Worker-only derivative of the previous Instapaper MCP codebase. Local stdio transport, npm CLI packaging, committed build artifacts, and standalone-repository CI are intentionally not maintained here.

## License

MIT. Upstream license and attribution are preserved.
