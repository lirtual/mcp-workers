# #119 — Current-account acceptance ledger

Issue: [#119](https://github.com/lirtual/mcp-workers/issues/119). Parent: [#110](https://github.com/lirtual/mcp-workers/issues/110); implementation: [Draft PR #120](https://github.com/lirtual/mcp-workers/pull/120).

**Account selection:** owner authorized use of their current Raindrop account on 2026-09-20. This does **not** authorize changing pre-existing bookmarks, tags, collections, highlights or Trash. All mutable test objects must be created for this test, uniquely named, recorded by ID and scoped explicitly.

**Evidence as of 2026-09-20:** Existing production Worker diagnostics were reachable and advertised v2.4.5 (17 tools), not v3; this does not count as v3 acceptance. An isolated deployment attempt for `raindrop-mcp-worker-v3-test` ran in [Actions #35510338549](https://github.com/lirtual/mcp-workers/actions/runs/35510338549). The v3 application check passed, but Wrangler rejected creation of the new Worker because its required `MCP_ACCESS_TOKEN` and `RAINDROP_ACCESS_TOKEN` bindings had not been supplied. The Cloudflare management secret-initialization action was unavailable in this session. **No v3 Worker was deployed; no v3 real-account HTTP read or write was executed.** The production Worker and original collection data were not altered. Keep PR #120 Draft while #118's final review is outstanding.

**2026-09-20 direct-MCP follow-up:** The branch now includes `scripts/test-direct-mcp.mjs` and an isolated GitHub Actions deployment with a per-run random `MCP_ACCESS_TOKEN`, a secret-file upload and direct authenticated `/mcp` checks (no Portal). [Run #35510822074](https://github.com/lirtual/mcp-workers/actions/runs/35510822074) stopped safely during credential preflight because the environment secret `RAINDROP_V3_TEST_ACCESS_TOKEN` was not available. No deployment or remote v3 MCP invocation occurred. The account token was not committed or printed. Grant the Cloudflare connector a usable action to bind the provided test token, or provision that token into the isolated GitHub Actions environment secret; neither needs an account-wide or production deployment.

**Cloudflare isolation update (2026-09-20):** Cloudflare management API successfully created the separate `raindrop-mcp-worker-v3-test` with a temporary 503-only initialization script. The user-supplied temporary `RAINDROP_ACCESS_TOKEN` was stored as a Secret on this test Worker; confirmed by a binding-name-only settings read. Attempts to initialize a separate `MCP_ACCESS_TOKEN` through the connected management action were blocked, so the v3 application was **not** deployed and `/mcp` was **not** tested. The production `raindrop-mcp-worker` was untouched. The temporary Raindrop token is still stored in the test Worker; rotate/revoke it when testing is finished or abandoned. The existing Actions workflow remains blocked by its absent GitHub environment secret until a supported credential-provisioning path is available. No account data was mutated.

## Read-only smoke on the existing account (safe to run first)

This is explicitly opt-in, uses a local environment credential, and prints neither the credential nor personal item content. The source file is `tests/v3_live_readonly.test.ts`. It tests the app's MCP Client -> tool handler -> Raindrop API path, **not** a deployed Worker or Portal connection.

1. In the application directory, put **only** `RAINDROP_ACCESS_TOKEN` in the existing Git-ignored local `.env` (or supply it as a local environment variable). Never send it in chat, commit it, or store it as a GitHub Action log/argument. Do not reuse the Worker's `MCP_ACCESS_TOKEN` as the business API credential.
2. From that directory: `RUN_LIVE_API_TESTS=true pnpm run test:live:readonly`. In Windows PowerShell, set `$env:RUN_LIVE_API_TESTS = "true"`, then run `pnpm run test:live:readonly`.
3. Record date, tested commit, test case counts, account entitlement result, and failure codes **without** copying user profile, bookmark text, token or full URLs into the issue. If duplicate/broken filtering is plan-blocked it must be reported **Blocked**, never as a successful empty result.

Run the default `pnpm check` independently. The explicit live test is excluded from `test:local`, and the two unset/false gates cause it to skip on ordinary CI. An empty or large real account may still expose upstream-specific bounds; a read error must not be reclassified as success.

## Scoped write lifecycle — pending #118 and authenticated execution

The current account is not an isolated disposable account, so the destructive operations below require tighter protections:

- [ ] Generate a unique run prefix, e.g. `mcp-v3-acceptance-<run-id>`. Snapshot no personal content.
- [ ] Create two private test collections A/B and a child of A. Record the returned exact IDs before any other writes.
- [ ] Create **new** test bookmarks with unique test links, notes and tags inside A only; record all IDs. Use only these IDs and collections for create/read/update/move/scoped delete and highlight lifecycle.
- [ ] Test tag rename/merge only with newly created globally unique test tag names; avoid affecting any existing tag with the same name. If ownership cannot be verified, mark the test **Blocked**.
- [ ] Parent-to-root: keep the `FEATURE_UNVERIFIED` gate closed until a separate isolated candidate, exact parent serialization and evidence can be tested safely.
- [ ] Scoped-delete: verify a test bookmark placed in B is unaffected by a source-A deletion; never probe with an existing bookmark ID.
- [ ] Duplicate/broken filters and entitlement: use read-only evidence first. Keep `duplicates_delete(confirm=true)` disabled unless a reviewed commit records clear semantics and test-created candidates.
- [ ] Do **not** run `trash_empty(confirm=true)` on this account unless every item in the entire Trash was created for the test and the inventory is verified immediately before execution. Generally leave it untested.
- [ ] Perform targeted cleanup of **only** returned test IDs; verify the exact parent and source for each deletion, re-read affected targets and record test items left behind if uncertain. Never use account-wide cleanup.
- [ ] Exercise deployed Worker/Portal discovery only after an approved v3 deployment: exact 26 tools, one safe read, authentication, redacted logs and Free-plan CPU/memory evidence. Direct local tests cannot satisfy this step.

## Evidence table

| Check | Status | Evidence / remaining blocker |
| --- | --- | --- |
| Offline 26-tool discovery and contract | Pass at last green CI SHA `fd77fda` | [CI](https://github.com/lirtual/mcp-workers/actions/runs/35507962617); recheck after later commits |
| Current-account read-only MCP smoke | Blocked | [#35510822074](https://github.com/lirtual/mcp-workers/actions/runs/35510822074): RAINDROP_V3_TEST_ACCESS_TOKEN unavailable in isolated deploy environment; direct v3 endpoint not created |
| Current-account scoped object lifecycle | Not run | Requires #118 gate and local authenticated execution with recorded new IDs |
| Parent-to-root write | Blocked | Compile-time `FEATURE_UNVERIFIED` gate |
| Duplicate deletion write | Blocked | Compile-time `FEATURE_UNVERIFIED` gate; operator/plan unverified |
| Entire Trash purge | Not run | Existing Trash could contain non-test entries |
| Deployed direct Worker (no Portal) | Blocked | Separate v3 test Worker has not deployed; existing production remains v2.4.5; Portal not used |
| Free-plan resource measurements | Not run | Wrangler dry-run is not real CPU/memory evidence |

Every status must be updated from actual observations; preparing a test or passing mock CI does not turn a **Not run** or **Blocked** cell into a pass.
