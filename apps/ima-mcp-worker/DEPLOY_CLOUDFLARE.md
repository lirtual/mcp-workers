# Cloudflare deployment

## Architecture

Cloudflare MCP Portal → ima-mcp-worker → IMA OpenAPI. The Worker does not export notes/media to public file hosts. The historical SQLite Durable Object class and binding are preserved inert for compatibility.

## Build and deploy

From the monorepo root:

```bash
pnpm install --frozen-lockfile
pnpm --filter ima-mcp-worker run check
```

Deploy only through the separately authorized manual Worker release workflow.

Required Worker Secrets:

```text
IMA_CLIENT_ID
IMA_API_KEY
MCP_ACCESS_TOKEN
```

No R2 storage binding, Litterbox configuration, public download domain, or other export credential is required. Do not delete the old R2 bucket/domain/objects or the historical Durable Object in this change.

## Verify

- `GET /health` returns `ok: true`.
- `GET /ready` returns `ready: true` when the three required secrets are set.
- Unauthenticated `POST /mcp` returns 401.
- Portal `tools/list` no longer advertises `export_file` or an `export_to_temporary` argument.
- `get_note` and `read_knowledge_source` still return bounded data, and importing files into IMA remains available.
- The Worker has no code path for Litterbox uploads, note export, knowledge-file export, or image-refresh RPC.
- Required Secrets, observability, and the inert Durable Object binding remain unchanged.
