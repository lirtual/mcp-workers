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

The Agent-facing MCP contract follows [Spec #145](https://github.com/lirtual/mcp-workers/issues/145) and the accepted [ADR in PR #144](https://github.com/lirtual/mcp-workers/pull/144): **25 atomic tools** replace the old 41-name compatibility inventory. This README describes the implementation branch; production remains on the previously published 41-name version until a separately authorized release.

- Collections: `collection_list`, `collection_get`, `collection_create`, `collection_update`, `collection_delete`, `collection_remove_empty`
- Bookmarks: `bookmark_search`, `bookmark_get`, `bookmark_exists`, `bookmark_create`, `bookmark_update`, `bookmark_move`, `bookmark_delete`, `bookmark_filters_get`, `bookmark_batch_update`, `bookmark_batch_delete`
- Tags: `tag_list`, `tag_rename`, `tag_merge`, `tag_delete`
- Highlights: `highlight_list`, `highlight_create`, `highlight_update`, `highlight_delete`
- Scoped duplicate cleanup: `bookmark_remove_duplicates`

**Safety boundary:** `bookmark_delete` only moves non-Trash bookmarks to Trash; `permanent:true` is not accepted. Agent-facing collection creation and updates reject `public:true`; public sharing and irreversible Trash deletion remain manual Raindrop website operations. `trash_empty`, `diagnostics`, `library_audit`, obsolete aliases, and AI suggestion wrappers are **not registered as Agent tools**.

Scoped high-impact writes retain their existing ID/collection validation, bounded batch limits, preview/digest confirmation where already implemented, and unknown-outcome no-replay rule. Explicit, sufficiently scoped instructions need no extra verbal confirmation, but cannot bypass any tool-mandated preview/confirmation step. Client-side approval is not a server-side authorization guarantee.

Existing public read and write paths are exercised through MCP SDK `tools/list` and `tools/call` integration tests; no additional authentication, workflow, or approval service is introduced.

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

### T10 release readiness

See [Spec #145](https://github.com/lirtual/mcp-workers/issues/145) for the 25-tool public cutover contract; [T10 readiness](docs/T10-CONTRACT-READINESS.md) records historical G0 evidence and earlier 41-name compatibility decisions. This branch does not authorize production deployment or destructive live testing.

The Draft follow-up fixes strict unknown-field rejection for collection_list and declares a validated structured output schema for bookmark_remove_duplicates. These mock/SDK contract fixes are not live Raindrop acceptance or release permission.
