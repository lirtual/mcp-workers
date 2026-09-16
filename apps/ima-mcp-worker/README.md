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
       ↓ public custom domain
https://ima-files.lirtual.dpdns.org/exports/...
```

This deployment is intentionally **single-user**. The Worker is stateless for authentication and does not use D1 or host its own OAuth provider.

The credential boundaries are independent:

- Client-facing authentication is owned by Cloudflare MCP Portal.
- Portal-to-Worker authentication uses this Worker's dedicated `MCP_ACCESS_TOKEN` through the shared `@mcp-workers/portal-auth` boundary.
- IMA business authentication uses `CLIENT_ID` and `API_KEY`.
- R2 export downloads do not pass through the Worker. They use the R2 bucket's public custom domain directly.

Do not reuse one credential for another layer or reuse this Worker's access token for another Worker. The Portal bearer is removed before the MCP SDK or IMA tool code receives the request.

IMA has no direct browser-client requirement. Server-to-server `/mcp` requests without an `Origin` header are accepted after bearer validation; `/mcp` requests that contain an `Origin` header are rejected.

## Features

- Notes: search/list/read/create/append/export
- Knowledge bases: search/list/read/search/import URL/link note/upload file/export
- File export to Cloudflare R2 with direct custom-domain download URLs
- Unique per-export R2 keys so a newer export cannot overwrite an older object
- Streamable HTTP `/mcp`
- `/health` and `/ready`
- HTTPS-only remote file ingestion with redirect and private-network filtering
- Existing read/write tool surface for the authorized single operator

## Cloudflare resources

- Workers
- R2
- R2 custom domain
- Worker Secrets
- Workers Observability
- Optional Durable Object only when the image-refresh shard feature is present

No D1 database, Queue, Cron, download-session store, or Worker download proxy is required.

## Required runtime configuration

Worker Secrets:

- `CLIENT_ID`
- `API_KEY`
- `MCP_ACCESS_TOKEN`

R2:

- binding: `R2_BUCKET`
- production bucket: `ima-mcp-worker`
- export object prefix: `exports/`
- production public custom domain: `ima-files.lirtual.dpdns.org`

Non-secret variable:

- `R2_PUBLIC_BASE_URL=https://ima-files.lirtual.dpdns.org`

Other optional variables include `IMA_BASE_URL` and the existing transfer size/timeout limits.

## Direct R2 download behavior

`export_file` and R2-backed reads return a direct object URL shaped like:

```text
https://ima-files.lirtual.dpdns.org/exports/<type>/<id>/<export-uuid>/<filename>
```

The Worker writes the object to R2 and returns the corresponding custom-domain URL. `/download/*` is not implemented by the Worker and no HMAC signing secret, expiry query parameter, or Worker download relay is used.

Every export receives a server-generated UUID in its R2 key. Re-exporting the same note/media filename therefore creates a new object instead of overwriting an older export.

The R2 custom domain makes objects reachable directly from the Internet. The UUID path reduces accidental discovery but is not an authentication boundary. Use an R2 lifecycle rule if exported objects should be removed automatically, and disable the `r2.dev` public development URL when the production custom domain is used.

## Deploy

See [DEPLOY_CLOUDFLARE.md](./DEPLOY_CLOUDFLARE.md).

For MCP Portal configuration, see [docs/mcp-portal.md](./docs/mcp-portal.md).

## Naming

- GitHub app directory: `apps/ima-mcp-worker`
- Cloudflare Worker service: `ima-mcp-worker`
- R2 bucket: `ima-mcp-worker`
- R2 public custom domain: `ima-files.lirtual.dpdns.org`
