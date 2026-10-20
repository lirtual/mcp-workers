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

The regression-tested tool inventory contains 41 tools, including the original 17. T10 assesses release readiness only; see [contract readiness and cutover blockers](docs/T10-CONTRACT-READINESS.md). Selected tools:

- `diagnostics`
- `collection_list`
- `collection_delete`
- `collection_remove_empty`
- `get_collection_tree`
- collection_manage (legacy delete disabled; use collection_delete preview/confirm)
- `bookmark_search`
- `bookmark_manage`
- `get_raindrop`
- `list_raindrops`
- `get_suggestions`
- `suggest_tags`
- bulk_edit_raindrops (legacy writes disabled; use bookmark_batch_update/delete)
- `bookmark_batch_update`
- `bookmark_batch_delete`
- `tag_manage`
- `highlight_list`
- `highlight_create`
- `highlight_update`
- `highlight_delete`
- `highlight_manage` (legacy adapter; requires bookmarkId and string highlightId for update/delete)
- `library_audit`
- `trash_empty` (full preview and digest confirmation)
- `empty_trash` (legacy migration guidance)
- `cleanup_collections`
- `bookmark_remove_duplicates`
- `remove_duplicates` (legacy guidance; execution disabled)

`bookmark_batch_update` and `bookmark_batch_delete` require one positive source `collectionId` and 1–50 explicit unique positive safe-integer `ids`. Every bookmark is freshly checked for source membership before a single bulk write; moves also freshly verify the positive `destinationCollectionId`. Updates support `tagsToAdd` (nonempty, distinct names), `clearTags: true` (mutually exclusive with `tagsToAdd`), `destinationCollectionId`, and `important`, with at least one change required. Delete moves bookmarks to Trash; system source collections, search and nesting are rejected. The Service caps total HTTP attempts including read retries at 60 and never replays writes. Results partition IDs into `succeeded`, `failed`, `unknown` and `notExecuted`; preflight failure means no write. Aggregate `result: true` / `modified` cannot prove individual outcomes, so acknowledged bulk writes still return per-ID `unknown`, including when the count matches. Inspect current state before deciding whether to retry. See the [official bulk API contract](https://developer.raindrop.io/v1/raindrops/multiple).

`collection_delete({id})` previews a complete subtree (root included), ascending `collectionIds`, `total` collection count, verified direct bookmark counts and `bookmarkCount`. `collection_remove_empty({rootId})` previews only empty leaves within that explicit positive scope; `collections` still describes the complete verified scoped subtree. Confirm either with the same scope plus `confirm: true`, `expectedTotal`, exact ordered `collectionIds`, and `digest`. The versioned SHA-256 digest binds the operation, root, canonical sorted membership (ID, parent ID, direct count), and candidates. Fresh owner-level (`access.level: 4`) metadata and direct-only bookmark counts must agree. Confirm recomputes everything before any writes; empty-leaf removal also rechecks the fresh hierarchy and metadata before each individual DELETE, without expanding the approved set to newly emptied parents. No global cleanup endpoint is used by these two tools. Large scopes fail preflight within the shared 60 HTTP-attempt budget. DELETE cascades descendants and moves bookmarks to Trash. Outcome arrays identify actual DELETE targets; one successful root DELETE covers its previewed subtree. Execution stops on the first failure or unknown acknowledgement. A digest is neither authorization nor a transactional lock, and concurrent upstream changes remain possible.

Trash emptying uses `trash_empty({})` to enumerate all IDs with stable counts via fresh `GET /raindrops/-99` pages (50 items, nested=false) and an empty terminal page. Confirm with `{confirm:true, collectionId:-99, expectedTotal:preview.total, digest:preview.digest}`; a fresh full enumeration must match before one bodyless `DELETE /collection/-99`. The 60 HTTP attempt budget includes retries and the write; infeasible scopes fail closed with guidance to `bookmark_delete permanent:true` using explicit limited IDs. Empty Trash confirmation sends no write. Outcomes are `preview`, `notExecuted`, `succeeded`, `failed`, or `unknown`; only result:true establishes success. Unverified preflight failures omit total/ids/digest rather than inventing an empty snapshot. Never blindly retry unknown outcomes. The digest is not a transactional lock; concurrent changes between reread and deletion remain possible. Legacy `empty_trash` provides guidance without reads and rejects `confirm:true`. Legacy `cleanup_collections` provides migration guidance without scanning and rejects `confirm:true` before any upstream call; use `collection_remove_empty` with an explicit positive `rootId` and its exact preview/confirm contract. Legacy `remove_duplicates` provides migration guidance only and rejects `dryRun: false` before any upstream call. Use `bookmark_remove_duplicates({collectionId: 123})` for a fresh, single-collection official `duplicate:true` preview, then pass its exact `confirmation` object as `confirm`. This object contains a versioned SHA-256 digest, sorted `candidateIds`, `keeperIds`, and deletion `total`, bound to the complete observed filter snapshot and full fresh metadata. The tool caps the scope at 50 filtered results and 10 eligible deletions, failing closed rather than truncating. It compares exact URL strings, preserves a verified keeper per group (preferring protected copies), and protects notes, highlights, tags, favorites, reminders and missing metadata. A sole official candidate is retained because the filter may omit canonical originals. Reads and retries share a 60-attempt budget. Confirmation recomputes the snapshot and rechecks candidates and keepers before one T06 batch DELETE. Aggregate acknowledgement still leaves individual outcomes unknown; inspect results before any manual retry. A digest is neither permission nor a transaction lock: concurrent upstream mutations remain possible. Tests use mocks; live writes require separate authorization.

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

See docs/T10-CONTRACT-READINESS.md for the **current 26-candidate tool matrix**, the **15 retained legacy-compatible names** (41 registered names in the Draft), historical migration evidence, and the blocked production cutover verdict. The withdrawn `bookmark_suggest` candidate must not be reintroduced without separate approval. No merge, published-tool cutover, or global destructive action is authorized; limited disposable-data acceptance is separately scoped.

The Draft follow-up fixes strict unknown-field rejection for collection_list and declares a validated structured output schema for bookmark_remove_duplicates. These mock/SDK contract fixes are not live Raindrop acceptance or release permission.
