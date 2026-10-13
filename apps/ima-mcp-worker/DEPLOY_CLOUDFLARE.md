# Cloudflare deployment

## Architecture

Cloudflare MCP Portal → ima-mcp-worker → IMA OpenAPI. Explicit exports upload to public Litterbox for temporary 24-hour download URLs. The Durable Object image-refresh binding is retained.

## Build and deploy

From the monorepo root:

```bash
pnpm install --frozen-lockfile
pnpm --filter ima-mcp-worker run check
```

Deploy using the repository's established workflow or `pnpm --filter ima-mcp-worker run deploy`.

Required Worker secrets:

```bash
pnpm --filter ima-mcp-worker exec wrangler secret put CLIENT_ID
pnpm --filter ima-mcp-worker exec wrangler secret put API_KEY
pnpm --filter ima-mcp-worker exec wrangler secret put MCP_ACCESS_TOKEN
```

No R2 storage binding, public download custom domain, or other export credential is required. Check existing files and other consumers before separately deleting the former Cloudflare R2 bucket.

## Verify

- `GET /health` returns `ok: true`.
- `GET /ready` returns `ready: true` when the three required secrets are set.
- Unauthenticated `POST /mcp` returns 401.
- `export_file(note_id)` and `export_file(media_id)` return Litterbox URLs with `expires_in: "24h"`.
- Default `read_knowledge_source` returns bounded chunks without a third-party upload.
- `read_knowledge_source(export_to_temporary=true)` performs an explicit upload.
- Oversized exports, upload errors, and unexpected response URLs fail without fabricating download links.
- Expired image URL refresh failures abort note export before upload.

Temporary URLs are publicly reachable by anyone holding them. Verify Worker connectivity and service acceptance with an authorized, non-sensitive sample file before depending on production exports.
