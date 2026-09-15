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
```

This deployment is intentionally **single-user**. The Worker is stateless for authentication and does not use D1 or host its own OAuth provider.

The credential boundaries are independent:

- Client-facing authentication is owned by Cloudflare MCP Portal.
- Portal-to-Worker authentication uses this Worker's dedicated `MCP_ACCESS_TOKEN` through the shared `@mcp-workers/portal-auth` boundary.
- IMA business authentication uses `CLIENT_ID` and `API_KEY`.

Do not reuse one credential for another layer or reuse this Worker's access token for another Worker. The Portal bearer is removed before the MCP SDK or IMA tool code receives the request.

IMA has no direct browser-client requirement. Server-to-server requests without an `Origin` header are accepted after bearer validation; requests that contain an `Origin` header are rejected.

## Features

- Notes: search/list/read/create/append/export
- Knowledge bases: search/list/read/search/import URL/link note/upload file/export
- File export to Cloudflare R2
- Streamable HTTP `/mcp`
- `/health` and `/ready`
- HTTPS-only remote file ingestion with redirect and private-network filtering
- Existing read/write tool surface for the authorized single operator

## Cloudflare resources

- Workers
- R2
- Worker Secrets
- Workers Observability
- Optional Durable Object only when the image-refresh shard feature is present

No D1 database is required.

## Required runtime configuration

Worker Secrets:

- `CLIENT_ID`
- `API_KEY`
- `MCP_ACCESS_TOKEN`

R2:

- binding: `R2_BUCKET`
- production bucket: `ima-mcp-worker`

Optional variables include `R2_CUSTOM_DOMAIN`, `PUBLIC_BASE_URL`, `IMA_BASE_URL`, and the existing transfer size/timeout limits.

## Deploy

See [DEPLOY_CLOUDFLARE.md](./DEPLOY_CLOUDFLARE.md).

For MCP Portal configuration, see [docs/mcp-portal.md](./docs/mcp-portal.md).

## Naming

- GitHub repository: `ima-mcp-worker`
- Cloudflare Worker service: `ima-mcp-worker`
- R2 bucket: `ima-mcp-worker`

The repository, Worker service, and production R2 bucket intentionally share the same name.
