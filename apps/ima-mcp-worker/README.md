# IMA MCP for Cloudflare Workers — v0.5.0

Cloudflare-native MCP server for Tencent IMA notes and knowledge bases.

## Architecture

```text
ChatGPT / MCP client
       ↓
Cloudflare MCP Portal
       ↓ Authorization: Bearer <MCP_ACCESS_TOKEN>
Cloudflare Worker: ima-mcp-worker
       ↓ Worker Secrets: CLIENT_ID + API_KEY
IMA OpenAPI

ima-mcp-worker Worker
       ↓ R2 binding: R2_BUCKET
R2 bucket: ima-mcp-worker
       ↓ R2 custom domain
https://temp.lirtual.dpdns.org/exports/...
```

This deployment is intentionally **single-user**. The Worker is stateless for authentication and does not use D1 or host its own OAuth provider.

Credential boundaries are independent:

- Client-facing authentication is owned by Cloudflare MCP Portal.
- Portal-to-Worker authentication uses this Worker's dedicated `MCP_ACCESS_TOKEN` through `@mcp-workers/portal-auth`.
- IMA business authentication uses `CLIENT_ID` and `API_KEY`.
- Exported files are stored in R2 and downloaded directly from the configured R2 custom domain; the Worker is not in the download path.

## Features

- Notes: search/list/read/create/append/export
- Knowledge bases: search/list/read/search/import URL/link note/upload file/export
- File export to Cloudflare R2 with direct custom-domain download URLs
- Unique per-export R2 keys so repeated exports do not overwrite earlier objects
- Streamable HTTP `/mcp`
- `/health` and `/ready`
- HTTPS-only remote file ingestion with redirect and private-network filtering

## Required runtime configuration

Worker Secrets:

- `CLIENT_ID`
- `API_KEY`
- `MCP_ACCESS_TOKEN`

R2:

- binding: `R2_BUCKET`
- production bucket: `ima-mcp-worker`
- public/custom domain: `https://temp.lirtual.dpdns.org`

Required non-secret Worker variable:

- `R2_PUBLIC_BASE_URL` — public base URL of the R2 bucket custom domain, for example `https://temp.lirtual.dpdns.org`

Optional variables include `IMA_BASE_URL` and the existing transfer size/timeout limits.

`wrangler.jsonc` uses `keep_vars: true`, so Dashboard-managed non-secret variables such as `R2_PUBLIC_BASE_URL` are preserved across deployments. Secrets remain managed as Cloudflare Worker Secrets.

## Export downloads

`export_file` and R2-backed reads return URLs shaped like:

```text
https://temp.lirtual.dpdns.org/exports/<type>/<id>/<export-id>/<filename>
```

Every export receives a generated UUID in its R2 key. Re-exporting the same note/media filename therefore creates a new object instead of overwriting an older export.

If automatic cleanup is desired, configure an R2 Object Lifecycle Rule for the `exports/` prefix. No Worker `/download` proxy, signing key, Cron, Queue, or download-session store is required.

## Cloudflare runtime defaults

The production Worker configuration keeps:

- `workers_dev: true`
- `preview_urls: false`
- `keep_vars: true`
- Workers Observability enabled with invocation logs

## Deploy

See [DEPLOY_CLOUDFLARE.md](./DEPLOY_CLOUDFLARE.md).

For MCP Portal configuration, see [docs/mcp-portal.md](./docs/mcp-portal.md).

## Naming

- GitHub app directory: `ima-mcp-worker`
- Cloudflare Worker service: `ima-mcp-worker`
- R2 bucket: `ima-mcp-worker`
