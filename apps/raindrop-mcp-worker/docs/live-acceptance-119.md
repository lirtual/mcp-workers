# #119 — Current-account acceptance ledger

Issue: [#119](https://github.com/lirtual/mcp-workers/issues/119). Parent: [#110](https://github.com/lirtual/mcp-workers/issues/110); implementation: [Draft PR #120](https://github.com/lirtual/mcp-workers/pull/120).

**Account selection:** owner authorized use of their current Raindrop account on 2026-09-20. This does **not** authorize changing pre-existing bookmarks, tags, collections, highlights or Trash. All mutable test objects must be created for this test, uniquely named, recorded by ID and scoped explicitly.

**Current evidence (2026-09-20):** [Actions #35511457233 (attempt 2)](https://github.com/lirtual/mcp-workers/actions/runs/35511457233) successfully deployed v3.0.0 to an isolated test Worker and passed direct HTTP `/health`, 401 authentication rejection, JSON-RPC initialize, discovery of precisely 26 tools, authenticated upstream diagnostics and `collection_list`. [Actions #35512357739](https://github.com/lirtual/mcp-workers/actions/runs/35512357739) additionally passed creation, readback and rename of one uniquely named test collection; creation, readback and note update of one unique test bookmark; exact source-scoped bookmark delete preview/confirmation and known-empty test collection removal. The test bookmark was moved to Trash (the entire Trash was **not** purged). No pre-existing account item was modified or deleted; production remains v2.4.5 and PR #120 stays Draft pending the rest of #118/#119.

**Historical blocker — earlier 2026-09-20 attempt (resolved):** The branch now includes `scripts/test-direct-mcp.mjs` and an isolated GitHub Actions deployment with a per-run random `MCP_ACCESS_TOKEN`, a secret-file upload and direct authenticated `/mcp` checks (no Portal). [Run #35510822074](https://github.com/lirtual/mcp-workers/actions/runs/35510822074) stopped safely during credential preflight because the environment secret `RAINDROP_V3_TEST_ACCESS_TOKEN` was not available. No deployment or remote v3 MCP invocation occurred. The account token was not committed or printed. Grant the Cloudflare connector a usable action to bind the provided test token, or provision that token into the isolated GitHub Actions environment secret; neither needs an account-wide or production deployment.

**Historical blocker — earlier 2026-09-20 attempt (resolved):** Cloudflare management API successfully created the separate `raindrop-mcp-worker-v3-test` with a temporary 503-only initialization script. The user-supplied temporary `RAINDROP_ACCESS_TOKEN` was stored as a Secret on this test Worker; confirmed by a binding-name-only settings read. Attempts to initialize a separate `MCP_ACCESS_TOKEN` through the connected management action were blocked, so the v3 application was **not** deployed and `/mcp` was **not** tested. The production `raindrop-mcp-worker` was untouched. The temporary Raindrop token is still stored in the test Worker; rotate/revoke it when testing is finished or abandoned. The existing Actions workflow remains blocked by its absent GitHub environment secret until a supported credential-provisioning path is available. No account data was mutated.

## Read-only smoke on the existing account (safe to run first)

This is explicitly opt-in, uses a local environment credential, and prints neither the credential nor personal item content. The source file is `tests/v3_live_readonly.test.ts`. It tests the app's MCP Client -> tool handler -> Raindrop API path, **not** a deployed Worker or Portal connection.

1. In the application directory, put **only** `RAINDROP_ACCESS_TOKEN` in the existing Git-ignored local `.env` (or supply it as a local environment variable). Never send it in chat, commit it, or store it as a GitHub Action log/argument. Do not reuse the Worker's `MCP_ACCESS_TOKEN` as the business API credential.
2. From that directory: `RUN_LIVE_API_TESTS=true pnpm run test:live:readonly`. In Windows PowerShell, set `$env:RUN_LIVE_API_TESTS = "true"`, then run `pnpm run test:live:readonly`.
3. Record date, tested commit, test case counts, account entitlement result, and failure codes **without** copying user profile, bookmark text, token or full URLs into the issue. If duplicate/broken filtering is plan-blocked it must be reported **Blocked**, never as a successful empty result.

Run the default `pnpm check` independently. The explicit live test is excluded from `test:local`, and the two unset/false gates cause it to skip on ordinary CI. An empty or large real account may still expose upstream-specific bounds; a read error must not be reclassified as success.

## Scoped write lifecycle — partially verified on test-owned objects

The current account is not an isolated disposable account, so the destructive operations below require tighter protections:

- [x] Generate a unique run prefix, e.g. `mcp-v3-acceptance-<run-id>`. Snapshot no personal content.
- [ ] Create two private test collections A/B and a child of A. Record the returned exact IDs before any other writes.
- [ ] Create **new** test bookmarks with unique test links, notes and tags inside A only; record all IDs. Use only these IDs and collections for create/read/update/move/scoped delete and highlight lifecycle.
- [ ] Test tag rename/merge only with newly created globally unique test tag names; avoid affecting any existing tag with the same name. If ownership cannot be verified, mark the test **Blocked**.
- [ ] Parent-to-root: keep the `FEATURE_UNVERIFIED` gate closed until a separate isolated candidate, exact parent serialization and evidence can be tested safely.
- [ ] Scoped-delete: verify a test bookmark placed in B is unaffected by a source-A deletion; never probe with an existing bookmark ID.
- [ ] Duplicate/broken filters and entitlement: use read-only evidence first. Keep `duplicates_delete(confirm=true)` disabled unless a reviewed commit records clear semantics and test-created candidates.
- [ ] Do **not** run `trash_empty(confirm=true)` on this account unless every item in the entire Trash was created for the test and the inventory is verified immediately before execution. Generally leave it untested.
- [x] Perform targeted cleanup of **only** returned test IDs for the first lifecycle run; verified the bookmark's source and collection's name/empty-leaf status before deletion. The test bookmark remains in Trash by design. Never use account-wide cleanup.
- [ ] Exercise deployed Worker/Portal discovery only after an approved v3 deployment: exact 26 tools, one safe read, authentication, redacted logs and Free-plan CPU/memory evidence. Direct local tests cannot satisfy this step.

## Evidence table

| Check | Status | Evidence / remaining blocker |
| --- | --- | --- |
| Offline 26-tool discovery and contract | Pass at last green CI SHA `fd77fda` | [CI](https://github.com/lirtual/mcp-workers/actions/runs/35507962617); recheck after later commits |
| Current-account direct MCP smoke | Pass (specified checks) | [#35511457233 attempt 2](https://github.com/lirtual/mcp-workers/actions/runs/35511457233): health, 401, initialize, 26 tools, authenticated diagnostic and collection page |
| Current-account scoped object lifecycle | Partial pass | [#35512357739](https://github.com/lirtual/mcp-workers/actions/runs/35512357739): owned collection and bookmark create/get/update, source-scoped preview/delete and empty collection deletion; tags/highlights/bulk moves remain |
| Parent-to-root write | Blocked | Compile-time `FEATURE_UNVERIFIED` gate |
| Duplicate deletion write | Blocked | Compile-time `FEATURE_UNVERIFIED` gate; operator/plan unverified |
| Entire Trash purge | Not run | Existing Trash could contain non-test entries |
| Deployed direct Worker (no Portal) | Pass for test Worker only | v3.0.0 direct HTTP checks passed; production still v2.4.5; Portal never used |
| Free-plan resource measurements | Not run | Wrangler dry-run is not real CPU/memory evidence |

Every status must be updated from actual observations; preparing a test or passing mock CI does not turn a **Not run** or **Blocked** cell into a pass.
