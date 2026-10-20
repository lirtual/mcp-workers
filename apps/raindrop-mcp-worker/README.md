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

The regression-tested tool inventory contains 38 tools, including the original 17. Selected tools:

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
- `bookmark_batch_update`
- `bookmark_batch_delete`
- `tag_manage`
- `highlight_list`
- `highlight_create`
- `highlight_update`
- `highlight_delete`
- `highlight_manage` (legacy adapter; requires bookmarkId and string highlightId for update/delete)
- `library_audit`
- `empty_trash`
- `cleanup_collections`
- `remove_duplicates`

`bookmark_batch_update` and `bookmark_batch_delete` require one positive source `collectionId` and 1–50 explicit unique positive safe-integer `ids`. Every bookmark is freshly checked for source membership before a single bulk write; moves also freshly verify the positive `destinationCollectionId`. Updates support `tagsToAdd` (nonempty, distinct names), `clearTags: true` (mutually exclusive with `tagsToAdd`), `destinationCollectionId`, and `important`, with at least one change required. Delete moves bookmarks to Trash; system source collections, search and nesting are rejected. The Service caps total HTTP attempts including read retries at 60 and never replays writes. Results partition IDs into `succeeded`, `failed`, `unknown` and `notExecuted`; preflight failure means no write. Aggregate `result: true` / `modified` cannot prove individual outcomes, so acknowledged bulk writes still return per-ID `unknown`, including when the count matches. Inspect current state before deciding whether to retry. See the [official bulk API contract](https://developer.raindrop.io/v1/raindrops/multiple).

Cleanup tools use preview-first semantics: `empty_trash({})` and `cleanup_collections({})` do not delete anything; only `confirm: true` executes. `remove_duplicates({})` and `dryRun: true` preview verified candidates; only `dryRun: false` deletes. All three retain `destructiveHint: true` and the existing safe-candidate, batch, fail-closed and no-blind-retry protections. A preview is not a transaction lock: recheck the target state before confirmed operations. Tests and acceptance checks must not mutate a real Raindrop library without separate explicit authorization.

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

The application `check` runs TypeScript validation, lint, the local regression suite including the exact tool inventory, deterministic OpenAPI type regeneration, and Wrangler dry-run deployment validation.

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
