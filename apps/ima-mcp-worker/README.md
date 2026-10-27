# IMA MCP for Cloudflare Workers

Single-user MCP for Tencent IMA notes and knowledge bases.

## Architecture

ChatGPT / MCP client → Cloudflare MCP Portal → ima-mcp-worker → IMA OpenAPI.

Portal authentication and IMA credentials remain separated. The Worker has no database or object-storage dependency.

## Features

- Search, list, read, create, and append notes
- Search, list, and read knowledge bases; import URLs, link notes, and upload HTTPS files **into IMA COS**
- Read binary knowledge files in bounded chunks without uploading them to a third-party host

**Export is intentionally unsupported.** There is no `export_file` tool, `export_to_temporary` flag, Litterbox client, public download proxy, or image-refresh RPC. Import/upload **to** the IMA knowledge base remains supported and is not an export.

## Required configuration

Worker Secrets: `MCP_ACCESS_TOKEN` and `IMA_API_KEY`. Required non-secret `plain_text` Worker Variable: `IMA_CLIENT_ID`, supplied by the `ima-mcp-worker` GitHub Environment Variables for manual release.

Optional: `IMA_BASE_URL` and existing timeout/size limits. No R2, D1, public download domain, or download-signing key is needed. The already-deployed `IMA_IMAGE_REFRESH_SHARD` SQLite Durable Object class and binding are retained **inert** solely for backward-compatible deployment; no code invokes them. Existing DO storage and old R2 buckets are not deleted.

See [DEPLOY_CLOUDFLARE.md](./DEPLOY_CLOUDFLARE.md) and [docs/mcp-portal.md](./docs/mcp-portal.md).
