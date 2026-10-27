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

The Agent-facing MCP contract follows [Spec #145](https://github.com/lirtual/mcp-workers/issues/145) and the accepted [ADR in PR #144](https://github.com/lirtual/mcp-workers/pull/144): **24 Free-plan atomic tools** replace the old 41-name compatibility inventory. The production ChatGPT MCP directory was verified on 2026-10-21: exactly 24 Raindrop tools are exposed, separate from three MCP Portal management tools. This document also describes the matching source contract.

- Collections: `collection_list`, `collection_get`, `collection_create`, `collection_update`, `collection_delete`, `collection_remove_empty`
- Bookmarks: `bookmark_search`, `bookmark_get`, `bookmark_exists`, `bookmark_create`, `bookmark_update`, `bookmark_move`, `bookmark_delete`, `bookmark_filters_get`, `bookmark_batch_update`, `bookmark_batch_delete`
- Tags: `tag_list`, `tag_rename`, `tag_merge`, `tag_delete`
- Highlights: `highlight_list`, `highlight_create`, `highlight_update`, `highlight_delete`
- Pro-only duplicate cleanup is removed (no replacement tool)

**Safety boundary:** `bookmark_delete` only moves non-Trash bookmarks to Trash; `permanent:true` is not accepted. Agent-facing collection creation and updates reject `public:true`; public sharing and irreversible Trash deletion remain manual Raindrop website operations. `trash_empty`, `diagnostics`, `library_audit`, obsolete aliases, and AI suggestion wrappers are **not registered as Agent tools**.

Scoped high-impact writes retain their existing ID/collection validation, bounded batch limits, preview/digest confirmation where already implemented, and unknown-outcome no-replay rule. Explicit, sufficiently scoped instructions need no extra verbal confirmation, but cannot bypass any tool-mandated preview/confirmation step. Client-side approval is not a server-side authorization guarantee.

Existing public read and write paths are exercised through MCP SDK `tools/list` and `tools/call` integration tests; no additional authentication, workflow, or approval service is introduced.

## Configuration

Configure `RAINDROP_ACCESS_TOKEN` in the `raindrop-mcp-worker` GitHub Environment **Secret**. `MCP_ACCESS_TOKEN` comes from the GitHub Repository Secret by default (or a reviewed same-name Worker Environment override). Production credentials are synchronized only through the separately authorized main-only **Release Worker** workflow, not by direct `wrangler secret put` or Cloudflare Builds.

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

The source configuration is in `wrangler.jsonc`. Production publishing uses the monorepo's main-only GitHub Actions **Release Worker** selected-Worker workflow with explicit confirmation; Cloudflare Workers Builds is not the supported production publishing path.

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

See [Spec #145](https://github.com/lirtual/mcp-workers/issues/145) for the historical 25-tool cutover contract (now 24 tools after removing Pro-only duplicates); [T10 readiness](docs/T10-CONTRACT-READINESS.md) records historical G0 evidence and earlier 41-name compatibility decisions. The original Draft did not authorize deployment or destructive live testing; the final 24-tool Free-plan source has since been merged and published ([PR #148](https://github.com/lirtual/mcp-workers/pull/148), [release run #39554129177](https://github.com/lirtual/mcp-workers/actions/runs/39554129177)). ChatGPT Portal tool discovery and a scoped disposable-data production smoke test were completed on 2026-10-21. The live test passed bookmark create/update, Favorite positive and negative filtering, keyword/tag search, highlight create/update/delete, collection create/delete, and cleanup readback. The test bookmark was moved to Trash and remains recoverable; this is not a claim that all 24 tools were individually tested. See the acceptance record on [Issue #145](https://github.com/lirtual/mcp-workers/issues/145).

The Draft follow-up fixes strict unknown-field rejection for collection_list and previously declared a validated output schema for bookmark_remove_duplicates (now removed for Free plan). These mock/SDK contract fixes are not live Raindrop acceptance or release permission.


## Free plan scope

The Worker intentionally excludes Raindrop Pro duplicate cleanup and broken-link filters,
AI Suggestions, highlight annotations and unsupported collection color writes.
Regular highlights (text/color), bookmark notes, collections, tags and favorites remain supported.
The source exposes 24 atomic MCP tools; a successful build alone does not establish live deployment.
