# MCP Workers Migration Baseline — Ticket 01

Status: **static baseline captured; live Cloudflare/Portal checks not run**
Captured: 2026-09-15
Scope: exactly six MCP Worker repositories; **Quark MCP excluded**.

This document freezes source facts before any monorepo migration. It deliberately separates reproducible repository evidence from runtime evidence that requires Cloudflare/Portal access or secret-bearing environments.

## 1. Frozen source commits and provenance

| App | Source repository | Frozen commit | License/provenance status |
| --- | --- | --- | --- |
| IMA | `lirtual/ima-mcp-worker` | `9202e9e05dfc8b6ecc9511aaa7eb95f7fd2b0172` | MIT in `package.json`; `LICENSE` present (`d179dfd4f075bf5d4ad65be66ca953f748efdb73`) |
| OpenList | `lirtual/openlist-mcp-worker` | `7c7dbee12eb82d4e65d97d759d1610e0d0e170a4` | **No `LICENSE` file and no `license` field found in the frozen source. Resolve before old-repo archival.** |
| WeRead | `lirtual/weread-mcp-worker` | `8ab71db46b0298f3776a03fe48ffd49000477db4` | **No `LICENSE` file and no `license` field found in the frozen source. Resolve before old-repo archival.** |
| Database | `lirtual/database-mcp-worker` | `47ca8f95042475adf57a109da3d6eade189b3a44` | MIT in `package.json`; `LICENSE` present (`14fac913ccf80234b1848540089a3bbcb6e5283d`) |
| Raindrop | `lirtual/raindrop-mcp-worker` | `1714cabaa4245b91605178537a9480d04e01c35a` | MIT; derived from `adeze/raindrop-mcp`; upstream attribution retained in README |
| Instapaper | `lirtual/instapaper-mcp-worker` | `1ca24c93e350b39122d25c6076627eecc7be88f8` | MIT; Worker-only derivative of the previous `Instapaper-MCP` codebase; exact older source commit is not stated in the frozen README |

These values were independently read as current Git commits. They happen to match the SHA values previously captured through Git tree inspection; they are now confirmed as commit SHAs for this migration baseline.

## 2. Static MCP contract fingerprints

The source commit plus the registration-source blob/tree SHA is the reproducible static contract fingerprint. Live `tools/list` remains a separate runtime acceptance signal and is **not** fabricated here.

### IMA

Contract source: `src/tools.ts` @ `d0aabfebc9a41c352218e60322660dba52dc198f`

Always registered:
- `search_notes`
- `list_notes`
- `list_notebooks`
- `get_note`
- `search_knowledge_bases`
- `list_addable_knowledge_bases`
- `get_knowledge_base`
- `list_knowledge`
- `search_knowledge`
- `read_knowledge_source`
- `export_file`

Conditionally registered when `allowWrite` is enabled:
- `create_note`
- `append_note`
- `add_urls_to_knowledge_base`
- `add_note_to_knowledge_base`
- `upload_file_to_knowledge_base`

Important baseline behavior: `export_file` is annotated `readOnlyHint: true` but performs an R2 export. Production smoke selection must therefore never infer “no side effects” from the annotation alone.

Resources/prompts: no explicit resource/prompt registry was captured from the primary tool registration source. Live protocol listing: **Not run**.

Representative safe runtime call candidate: `list_notebooks` — **Not run**.

### OpenList

Contract source: `src/tools/register.ts` @ `9ab9ee313cd4914c482e4252b7efd6d1f6d15fd0`

Always registered before readonly short-circuit:
- `get_capabilities`
- `list_files`
- `list_dirs`
- `get_file_info`
- `search_files`
- `get_download_url`
- `list_tasks`
- `get_task_info`

Registered only when `config.readonly === false`:
- `create_folder`
- `rename`
- `copy`
- `move`
- `remove`
- `upload_file`
- `retry_task`
- `cancel_task`
- `delete_task`

Frozen Wrangler config sets `OPENLIST_READONLY="true"`, so the expected configured surface is the read subset unless another environment source overrides it. This expectation must be confirmed by live `tools/list` rather than assumed.

Resources/prompts: none captured in the primary registration source. Live protocol listing: **Not run**.

Representative safe runtime call candidate: `get_capabilities` — **Not run**.

### WeRead

Contract source: `src/server.ts` @ `913ba21952b68924df02c18466ca90e54b2d61d0`

Tools:
- `weread_search`
- `weread_get_bookshelf`
- `weread_get_book`
- `weread_get_notebooks`
- `weread_get_book_notes`
- `weread_get_popular_highlights`
- `weread_get_highlight_thoughts`
- `weread_get_reading_stats`
- `weread_get_public_reviews`
- `weread_get_recommendations`

The output schema uses `{ ok: true, data } | { ok: false, error }` structured content and must not be normalized during source migration.

Resources/prompts: none captured in the primary server source. Live protocol listing: **Not run**.

Representative safe runtime call candidate: `weread_get_bookshelf` — **Not run**.

### Database

Contract source: `src/mcp.ts` @ `dbd39be2c5d568aa77a90707ccaa89888390b619`

Tools:
- `list_connections`
- `inspect_schema`
- `query_read`
- `explain`
- `health_check`

The frozen implementation requires sanitized MCP auth context and applies an app-local rate limiter. Those semantics are part of the pre-migration behavior and are not to be removed during snapshot migration.

Resources/prompts: none captured in the primary server source. Live protocol listing: **Not run**.

Representative safe runtime call candidate: `list_connections` — **Not run**.

### Raindrop

Tool configuration root: `src/tools/` tree @ `50f87841236a224aba056bf3a167a01bf110d5f2`
Composition source: `src/tools/index.ts` @ `af58b87bef790001e6c54e43325d9c50ef9e0107`

Tools:
- `diagnostics`
- `collection_list`
- `get_collection_tree`
- `collection_manage`
- `bookmark_search`
- `bookmark_manage`
- `get_raindrop`
- `list_raindrops`
- `tag_manage`
- `highlight_manage`
- `bulk_edit_raindrops`
- `library_audit`
- `empty_trash`
- `cleanup_collections`
- `remove_duplicates`
- `get_suggestions`
- `suggest_tags`

Prompts captured in `src/services/raindropmcp.service.ts`:
- `organize_by_topic`
- `find_duplicates`
- `export_markdown`

Resources/patterns captured in that server source:
- `mcp://user/profile`
- `diagnostics://server`
- `mcp://collection/{id}`
- `mcp://raindrop/{id}`

Live protocol listing: **Not run**.

Representative safe runtime call candidate: `collection_list` — **Not run**.

### Instapaper

Contract source: `src/mcp/server.ts` @ `b733981ac33c563ab5e02a457c1264d6eaa12724`

Tools:
- `list_bookmarks`
- `get_article_content`
- `add_bookmark`
- `set_bookmark_starred`
- `set_bookmark_archived`
- `move_bookmark`
- `delete_bookmark`
- `list_folders`
- `create_folder`
- `list_highlights`
- `add_highlight`

Resources/prompts: none captured in the primary server source. Live protocol listing: **Not run**.

Representative safe runtime call candidate: `list_folders` — **Not run**.

## 3. Worker/runtime configuration baseline

| App | Worker/main | Compatibility | Reachability declared in repo | Non-secret bindings/config captured |
| --- | --- | --- | --- | --- |
| IMA | `ima-mcp-worker` / `src/index.ts` | `2026-09-11` | `workers_dev: true` | R2 `R2_BUCKET` -> bucket `ima-mcp-worker`; observability enabled |
| OpenList | `openlist-mcp-worker` / `src/index.ts` | `2026-09-13` | `workers_dev: false` | `OPENLIST_READONLY=true`, upload max `5242880`, timeout `15000`; observability enabled |
| WeRead | `weread-mcp-worker` / `src/index.ts` | `2026-09-13` | `workers_dev: false`, `preview_urls: false` | `nodejs_compat` flag |
| Database | Worker target name from package/docs: `database-mcp-worker`; main **not reproducibly located in a root Wrangler file** | **Not verified** | **No root `wrangler.jsonc` in frozen commit; actual deploy config/route source must be located before migration** | Hyperdrive/rate-limit resources are referenced by app code/docs but actual deployed binding IDs are **Not verified** |
| Raindrop | `raindrop-mcp-worker` / `src/worker.ts` | `2026-09-15` | `workers_dev: false`, `preview_urls: false` | observability enabled; rate-limit tuning vars `30/60/3` |
| Instapaper | `instapaper-mcp-worker` / `src/worker.ts` | `2026-09-01` | `workers_dev: false`, `preview_urls: false` | `nodejs_compat`, `global_fetch_strictly_public`; observability enabled |

No production URLs, custom-domain values, resource IDs, Portal upstream URLs, or secret values were inferred from names. For all Workers with `workers_dev: false`, actual reachable production route source is **Not verified** until Cloudflare configuration can be inspected.

## 4. Package/check command baseline

| App | Existing command contract at frozen commit | Gap relative to target spec |
| --- | --- | --- |
| IMA | `dev`, `deploy`, `typecheck`, `test` | no `check`; no documented dry-run in package scripts |
| OpenList | `dev`, `deploy`, `typecheck`, `test`, `lint`, `build` (`wrangler deploy --dry-run`) | no `check` |
| WeRead | `dev`, `deploy`, `typecheck`, `test`, `lint`, `check`, `test:mcp` | `check` does not include Wrangler dry-run |
| Database | `dev`, `deploy`, `typecheck`, unit/integration/all tests, `lint`, `check` | `check` runs `test:all` (environment-dependent integration included) and has no Wrangler dry-run |
| Raindrop | `dev`, `deploy`, `type-check`, `test`, `lint`, `check` with Wrangler dry-run | script is `type-check`, not target `typecheck`; otherwise closest to target contract |
| Instapaper | `build`, `typecheck`, `test`, `dev`, `deploy`, `deploy:dry-run` | no `check` |

These gaps are **baseline facts**, not changes authorized in Ticket #01. They are handled later by the workspace/command-contract tickets.

## 5. CI/config source fingerprints

| App | `package.json` blob | CI blob | Context/instruction pointer |
| --- | --- | --- | --- |
| IMA | `2adcb31811b49213d06bbd9775730c26065bc9b8` | `.github/workflows/ci.yml` `b5b6351fae3c53c3a45f37eabcab73cfb4354b55` | `CONTEXT.md` `f1f71e9584d69267e49feb5887a9b79aa340d95a` |
| OpenList | `037e2dd08247bcd6c97625837a5dca0ea4621ba5` | `.github/workflows/ci.yml` `fe737912a6c2e98a095b3a1b09ed5487cc573f3c` | `CONTEXT.md` `2a3a7c127d4dcfebb6f1d5b0426697dfeeecced0` |
| WeRead | `19aeb79f97195053310a3ca3c55ba7f744a8c127` | `.github/workflows/ci.yml` `fa8ed606dc974492b7b6c12eec603e42be05870e` | `CONTEXT.md` `b4d79c0c5e91507c5715996d33b5a9d6bd5bf104` |
| Database | `3f45c1c70b2a86db641a0cd010cb25c6794655e8` | `.github/workflows/ci.yml` `3fbda801704c04eac76b2940765a9aeb43ed8b57` | no root CONTEXT file captured in frozen tree; use `docs/spec.md`/architecture docs as app evidence |
| Raindrop | `a538751b263f5d8747a8c8acefdfd0f146d96327` | `.github/workflows/ci.yml` `0f88dd58f5bb274ecbd0f84ea4af17acf4668357` | `CONTEXT.md` `25e190bcc63fce97d6adf2b3708e12bc00db7fa8` |
| Instapaper | `368013fcae7f6c268612014f213d3ab9acccb183` | `.github/workflows/ci.yml` `f4ed8f55c358bf3a83e44661216b48656a6618db` | no CONTEXT file in frozen tree; README is current Worker-only scope pointer |

## 6. Runtime / Portal evidence status

The following were intentionally **Not run** in Ticket #01 because this execution environment does not expose the user's Cloudflare Worker/MCP Portal configuration or production secrets:

- live Worker `/health`
- MCP initialize/connect against production origins
- live `tools/list`, `resources/list`, `prompts/list`
- representative production tool calls
- Portal discovery and Portal-to-Worker real calls
- actual custom-domain/route mapping for Workers with `workers_dev: false`
- Cloudflare binding IDs and current production Worker versions
- current Portal Server IDs/URLs (the IDs in the spec are target names, not asserted as current production facts)

These are required later by the migration and final acceptance tickets. Missing runtime evidence is not recorded as Pass.

## 7. External blockers discovered while executing implement-spec

1. The intended private target repository `lirtual/mcp-workers` returned `404` through the connected GitHub integration, while other `lirtual/*` repositories are accessible with admin permission. The target repository therefore appeared not to exist / not be connected at Ticket #01 execution time.
2. The available GitHub integration can create branches, files, PRs, and issues in existing repositories, but no repository-creation action was exposed in that execution session.
3. No Cloudflare management surface was available in that execution session to inspect or mutate Worker Builds, routes, secrets, bindings, Worker Versions, or MCP Portal upstream configuration.

The repository blocker has since been cleared by the user; the Cloudflare/Portal runtime acceptance still requires an available management surface or explicit manual evidence.

## 8. Secret-redaction check

This baseline contains only repository names, commit/blob hashes, tool names, public configuration keys, non-secret configuration values, and secret **variable names** where architecturally relevant. It contains no actual bearer token, API key, OAuth secret, cookie, password, database credential, or temporary authenticated download URL.
