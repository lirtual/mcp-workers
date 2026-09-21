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

## MCP v3 tools (breaking source-branch contract)

The **v3 source branch** registers exactly 26 tools. The deployed Portal may
still expose a prior version until separately accepted and cut over; do not
assume that pushing this branch changes the active client.

| Capability | Public tools |
| --- | --- |
| Bookmark | `raindrop_list`, `raindrop_get`, `raindrop_create`, `raindrop_update`, `raindrop_delete`, `raindrop_bulk_update`, `raindrop_bulk_delete`, `raindrop_suggest` |
| Collection | `collection_list`, `collection_tree`, `collection_get`, `collection_create`, `collection_update`, `collection_delete` |
| Tags | `tag_list`, `tag_rename`, `tag_merge`, `tag_delete` |
| Highlights | `highlight_list`, `highlight_create`, `highlight_update`, `highlight_delete` |
| Maintenance | `library_audit`, `duplicates_delete`, `trash_empty`, `diagnostics` |

**No old tool names or arguments are registered in v3.** Clients must refresh
MCP tool discovery after an explicitly approved rollout. Retired v2 tool modules
and their obsolete tests have been removed from this source branch.
The old `suggest_tags` Sampling tool is not supported.

Dangerous operations default to preview. In particular:

- `collection_delete` re-reads the subtree and requires an exact descendant
  set before confirmed deletion; `onlyIfEmpty` requires a known-empty leaf.
- `collection_update(parent=null)` is disabled with `FEATURE_UNVERIFIED`
  pending isolated validation of move-to-root semantics.
- `duplicates_delete(confirm=true)` is disabled with
  `FEATURE_UNVERIFIED` pending live, read-only verification of the official
  duplicate filter and account entitlement. A preview is **not** a snapshot.
- `trash_empty(confirm=true)` targets the **entire current Trash**; never run
  this against an account containing pre-existing non-test Trash items.
- Reads are bounded, submitted writes are never automatically retried,
  and an uncertain upstream write is reported as unknown.

The historical `raindrop-complete.yaml` name does not imply complete REST API
coverage. The v3 generation source contains **16 active route shapes** used by
the 26 public tools. Its declarations are regenerated in
`src/types/raindrop.schema.d.ts` and verified by `pnpm run check:schema`.

An isolated `raindrop-mcp-worker-v3-test` has been exercised directly through
`/mcp` with test-owned data. This is separate from the production Portal
configuration and is **not** a production deployment or a Portal acceptance.

See `docs/api-coverage.md` for independent implementation, offline contract,
and live acceptance states. Offline fixtures and Wrangler dry-run **do not**
constitute a live Raindrop/Portal or Cloudflare Free-plan runtime acceptance.

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

`raindrop-complete.yaml` is the single canonical OpenAPI source retained by this application. The filename does not imply coverage of every official API; v3 supports only the scope above. Runtime code imports the generated `src/types/raindrop.schema.d.ts` types through `openapi-fetch`.

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

The application `check` runs TypeScript validation, lint, the local regression suite including the exact 26-tool contract, deterministic OpenAPI type regeneration, and Wrangler dry-run deployment validation.

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
