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
       ↑
GET /download/<object>?expires=...&sig=...
```

This deployment is intentionally **single-user**. The Worker is stateless for authentication and does not use D1 or host its own OAuth provider.

The credential boundaries are independent:

- Client-facing authentication is owned by Cloudflare MCP Portal.
- Portal-to-Worker authentication uses this Worker's dedicated `MCP_ACCESS_TOKEN` through the shared `@mcp-workers/portal-auth` boundary.
- IMA business authentication uses `CLIENT_ID` and `API_KEY`.
- Temporary export downloads use a separate IMA-only `IMA_DOWNLOAD_SIGNING_KEY`.

Do not reuse one credential for another layer or reuse this Worker's access token for another Worker. The Portal bearer is removed before the MCP SDK or IMA tool code receives the request, and it is never embedded in download URLs.

IMA has no direct browser-client requirement. Server-to-server `/mcp` requests without an `Origin` header are accepted after bearer validation; `/mcp` requests that contain an `Origin` header are rejected. Signed `/download/` links are capability URLs: possession of a valid, unexpired link is sufficient for the specific exported object.

## Features

- Notes: search/list/read/create/append/export
- Knowledge bases: search/list/read/search/import URL/link note/upload file/export
- File export to Cloudflare R2 with time-limited signed Worker download URLs
- Unique per-export R2 keys so a newer export cannot overwrite the object referenced by an older link
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

No D1 database, Queue, Cron, or download-session store is required.

## Required runtime configuration

Worker Secrets:

- `CLIENT_ID`
- `API_KEY`
- `MCP_ACCESS_TOKEN`
- `IMA_DOWNLOAD_SIGNING_KEY` — high-entropy secret used only for HMAC-SHA-256 temporary download links

Generate the download key independently from all other credentials, for example with a password/secret generator. Store it as a Cloudflare Worker Secret; never commit the value.

R2:

- binding: `R2_BUCKET`
- production bucket: `ima-mcp-worker`
- protected exports use the `exports/` object prefix
- do **not** expose protected export objects through an R2 public/custom-domain path; generated download URLs always go through the Worker verification route

Non-secret download policy variables:

- `IMA_DOWNLOAD_TTL_SECONDS` — default `3600` (1 hour)
- `IMA_EXPORT_RETENTION_SECONDS` — default `604800` (7 days); must be greater than or equal to the link TTL
- `PUBLIC_BASE_URL` — optional canonical Worker/custom-host origin. If omitted during MCP handling, the Worker request origin is used.

`IMA_EXPORT_RETENTION_SECONDS` documents and validates the intended retention contract; actual deletion is enforced with an R2 **Object Lifecycle Rule** at the bucket level. Configure the `ima-mcp-worker` bucket so objects with prefix `exports/` are deleted after 7 days (or the chosen retention period). Cloudflare supports prefix-scoped lifecycle deletion through the R2 dashboard or Wrangler lifecycle commands. The repository intentionally does not add a Cron/Queue cleanup service.

After configuring the bucket, verify it with:

```bash
npx wrangler r2 bucket lifecycle list ima-mcp-worker
```

Other optional variables include `IMA_BASE_URL` and the existing transfer size/timeout limits.

## Temporary download security

`export_file` and R2-backed reads return a URL shaped like:

```text
https://<worker-origin>/download/<encoded-object-key>?expires=<unix-seconds>&sig=<hmac>
```

The HMAC binds the HTTP method, exact R2 object key, and expiry. The Worker rejects missing or modified signatures, rejects expired URLs, and only serves keys under `exports/`. Successful responses use `Cache-Control: private, no-store` so an expired capability cannot be replayed from a public cache.

Every export receives a server-generated UUID in its R2 key. Re-exporting the same note/media filename therefore creates a new object instead of overwriting an object referenced by an older signed link.

The signing URL lifetime and R2 object retention are intentionally separate: a 1-hour link may expire while its object remains for the 7-day cleanup window. If the object has already been removed, a still-valid link returns `404` rather than reporting false success.

## Deploy

See [DEPLOY_CLOUDFLARE.md](./DEPLOY_CLOUDFLARE.md).

For MCP Portal configuration, see [docs/mcp-portal.md](./docs/mcp-portal.md).

## Naming

- GitHub repository: `ima-mcp-worker`
- Cloudflare Worker service: `ima-mcp-worker`
- R2 bucket: `ima-mcp-worker`

The repository, Worker service, and production R2 bucket intentionally share the same name.
