# Raindrop MCP Worker

Private Cloudflare Worker MCP server for Raindrop.io in the `mcp-workers` monorepo.

This application supports one production shape only:

```text
MCP client
  -> Cloudflare MCP Portal
  -> Bearer MCP_ACCESS_TOKEN
  -> https://raindrop-mcp-worker.aiyaya.workers.dev/mcp
  -> raindrop-mcp-worker
  -> RAINDROP_ACCESS_TOKEN
  -> Raindrop.io API
```

It is not published as an npm package and does not support standalone STDIO, standalone Node HTTP, MCPB/DXT, Smithery, Gemini extension, or public registry distribution from this monorepo.

## Runtime contract

- Worker name: `raindrop-mcp-worker`
- Public origin: `https://raindrop-mcp-worker.aiyaya.workers.dev`
- MCP endpoint: `/mcp`
- `workers_dev`: enabled
- preview URLs: disabled
- client ingress: Cloudflare MCP Portal only
- Portal credential: `MCP_ACCESS_TOKEN`
- upstream Raindrop credential: `RAINDROP_ACCESS_TOKEN`
- MCP handling: stateless per request
- automatic retry: bounded reads only; writes are never automatically replayed after reaching Raindrop.io

`MCP_ACCESS_TOKEN` and `RAINDROP_ACCESS_TOKEN` are separate credentials and must never be reused for each other.

## MCP tools

The exact supported tool-name contract is regression-tested and currently contains 17 tools:

- `diagnostics`
- `collection_list`
- `get_collection_tree`
- `collection_manage`
- `bookmark_search`
- `bookmark_manage`
- `get_raindrop`
- `list_raindrops`
- `get_suggestions`
- `suggest_tags`
- `bulk_edit_raindrops`
- `tag_manage`
- `highlight_manage`
- `library_audit`
- `empty_trash`
- `cleanup_collections`
- `remove_duplicates`

Destructive tools keep their explicit confirmation requirements. Tests and acceptance checks must not mutate a real Raindrop library unless a task explicitly authorizes that action.

## Configuration

Worker secrets:

```bash
pnpm --filter raindrop-mcp-worker exec wrangler secret put MCP_ACCESS_TOKEN
pnpm --filter raindrop-mcp-worker exec wrangler secret put RAINDROP_ACCESS_TOKEN
```

Optional Worker variable:

- `RAINDROP_RATE_LIMIT_MAX_RETRIES` — bounded retry count for safe read requests; default `3`.

Do not commit secret values to the repository.

## OpenAPI type generation

`raindrop-complete.yaml` is the single canonical OpenAPI source retained by this application. Runtime code imports the generated `src/types/raindrop.schema.d.ts` types through `openapi-fetch`.

Regenerate the schema types from the monorepo root with:

```bash
pnpm --filter raindrop-mcp-worker generate:schema
```

`pnpm --filter raindrop-mcp-worker check` also runs a determinism check and fails if regeneration changes the committed type file. The former duplicate spec and Axios client-generator path are not part of the maintained Worker architecture.

## Development and verification

From the monorepo root:

```bash
pnpm install --frozen-lockfile
pnpm --filter raindrop-mcp-worker check
```

The application `check` runs TypeScript validation, lint, the local regression suite including the exact 17-tool contract, deterministic OpenAPI type regeneration, and Wrangler dry-run deployment validation.

Optional tests that require a real `RAINDROP_ACCESS_TOKEN` remain outside the default CI-safe test set. `test:env` includes explicitly gated live checks, including a destructive lifecycle test; run those only with disposable/non-production test data and the documented opt-in flags, never as routine production cutover smoke.

## Deployment and Portal

The source configuration is in `wrangler.jsonc`. Production publishing is expected to use the monorepo as the single Cloudflare Workers Builds source.

Portal upstream target:

```text
https://raindrop-mcp-worker.aiyaya.workers.dev/mcp
```

See:

- `docs/cloudflare-mcp-portal.md` for deployment/Portal configuration.
- `docs/mcp-portal-acceptance-checklist.md` for the live acceptance sequence.

Account-level Cloudflare deployment, publisher cutover, Portal upstream changes, and production secret management are intentionally separate from source-only refactoring work.

## Source attribution

This Worker was migrated and adapted from an MIT-licensed Raindrop MCP implementation. The immutable source repository, frozen commit, and license provenance are recorded in `SOURCE.md`; the preserved license is in `LICENSE`.
