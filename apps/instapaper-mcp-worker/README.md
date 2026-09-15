# instapaper-mcp-worker

A focused **Cloudflare Worker-only** MCP server for Instapaper.

## Architecture

- MCP SDK v2 (`@modelcontextprotocol/server`)
- Stateless Streamable HTTP at `/mcp`
- Cloudflare MCP Portal + Managed OAuth / Access as the client-facing ingress
- Dedicated `MCP_ORIGIN_TOKEN` bearer authentication from Portal to Worker
- Instapaper Full API via OAuth 1.0a / HMAC-SHA1
- Instapaper credentials stay inside the Worker

```text
MCP client
  -> Cloudflare MCP Portal + Managed OAuth / Access
  -> Authorization: Bearer <MCP_ORIGIN_TOKEN>
  -> instapaper-mcp-worker /mcp
  -> Instapaper OAuth 1.0a credentials
  -> Instapaper API
```

The Worker validates and removes the origin `Authorization` header before the request reaches the MCP SDK or Instapaper domain code.

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
- Cloudflare Workers and MCP Portal / Zero Trust
- Instapaper Full API consumer key/secret
- Wrangler authenticated with Cloudflare

## Install

```bash
npm install
```

## Bootstrap Instapaper OAuth tokens

Run:

```bash
npm run setup:instapaper
```

The helper performs Instapaper xAuth, verifies the returned token, and writes these Worker secrets with Wrangler:

- `INSTAPAPER_CONSUMER_KEY`
- `INSTAPAPER_CONSUMER_SECRET`
- `INSTAPAPER_OAUTH_TOKEN`
- `INSTAPAPER_OAUTH_TOKEN_SECRET`

The Instapaper username/password are used only during bootstrap and are not persisted.

## Configure Portal-to-Worker authentication

Create a dedicated origin secret:

```bash
npx wrangler secret put MCP_ORIGIN_TOKEN
```

Cloudflare MCP Portal should send:

```text
Authorization: Bearer <MCP_ORIGIN_TOKEN>
```

Do not reuse an Instapaper credential for this value.

## Deploy

`wrangler.jsonc` disables `workers.dev` and preview URLs. Configure a production custom hostname reachable by MCP Portal, then run:

```bash
npm run deploy
```

The upstream MCP endpoint is:

```text
https://<worker-custom-domain>/mcp
```

Register that upstream in Cloudflare MCP Portal and configure its upstream Bearer credential to the same `MCP_ORIGIN_TOKEN` value. ChatGPT or another MCP client should connect to the **Portal URL**, not the raw Worker URL.

## Development

```bash
npm run typecheck
npm test
npm run build
npm run deploy:dry-run
```

## Security model

- Cloudflare MCP Portal owns client-facing OAuth / Access.
- `MCP_ORIGIN_TOKEN` authenticates only Portal-to-Worker traffic.
- Instapaper OAuth credentials authenticate only Worker-to-Instapaper traffic.
- The origin bearer is removed before MCP/domain processing.
- Instapaper username/password are bootstrap-only.
- Secrets and local environment files are ignored by Git.
- `delete_bookmark` is marked destructive; read tools are marked read-only.

## Notes

This repository is a cleaned Worker-only derivative of the previous `Instapaper-MCP` codebase. Local stdio transport, npm CLI packaging, and committed build artifacts were intentionally removed.

## License

MIT. Upstream license and attribution are preserved.
