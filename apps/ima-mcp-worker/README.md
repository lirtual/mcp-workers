# IMA MCP for Cloudflare Workers

Single-user MCP for Tencent IMA notes and knowledge bases.

## Architecture

ChatGPT / MCP client → Cloudflare MCP Portal → ima-mcp-worker → IMA OpenAPI.

Portal authentication and IMA credentials remain separated. The Worker has no database or object-storage dependency.

## Features

- Search, list, read, create, append, and export notes
- Search, list, and read knowledge bases; import URLs, link notes, and upload HTTPS files to IMA COS
- Export notes and knowledge files to **public Litterbox** with temporary 24-hour download URLs
- Read binary knowledge files in bounded chunks without automatically uploading to a third party
- Refresh up to 8 expired/unknown embedded-image URLs per note export directly inside the Worker (no Durable Objects)

## Temporary exports

The explicit `export_file` tool or `read_knowledge_source(export_to_temporary=true)` uploads via
`POST https://litterbox.catbox.moe/resources/internals/api.php`, using multipart fields
`reqtype=fileupload`, `time=24h`, and `fileToUpload`. A validated download URL and `expires_in: "24h"` are returned.

**Privacy:** Uploaded files are hosted by a third-party, publicly accessible service. Anyone with the URL can access the file before expiry. Do not export confidential material.

A note export needing more than **8 image URL refreshes** fails before any public upload. The bound reserves room for retries within the Workers Free 50-subrequest limit.\n\nThe Worker limits temporary uploads to **32 MiB** to manage its memory footprint. Litterbox may apply stricter content restrictions or be temporarily unavailable.

## Required configuration

Worker secrets: `MCP_ACCESS_TOKEN`, `CLIENT_ID`, and `API_KEY`.

Optional: `IMA_BASE_URL` and existing timeout/size limits. No R2, D1, public download domain, or download-signing key is needed. No Durable Objects are used. Existing namespace retirement requires a one-time deletion tombstone deployment.

See [DEPLOY_CLOUDFLARE.md](./DEPLOY_CLOUDFLARE.md) and [docs/mcp-portal.md](./docs/mcp-portal.md).
