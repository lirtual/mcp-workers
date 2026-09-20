# #119 — Current-account acceptance ledger

Issue: [#119](https://github.com/lirtual/mcp-workers/issues/119). Parent: [#110](https://github.com/lirtual/mcp-workers/issues/110); implementation: [Draft PR #120](https://github.com/lirtual/mcp-workers/pull/120).

**Account selection:** owner authorized use of their current Raindrop account on 2026-09-20. This does **not** authorize changing pre-existing bookmarks, tags, collections, highlights or Trash. All mutable test objects must be created for this test, uniquely named, recorded by ID and scoped explicitly.

**Current evidence (2026-09-20):** [Actions #35511457233 (attempt 2)](https://github.com/lirtual/mcp-workers/actions/runs/35511457233) successfully deployed v3.0.0 to an isolated test Worker and passed direct HTTP `/health`, 401 authentication rejection, JSON-RPC initialize, discovery of precisely 26 tools, authenticated upstream diagnostics and `collection_list`. [Actions #35512357739](https://github.com/lirtual/mcp-workers/actions/runs/35512357739) additionally passed creation, readback and rename of one uniquely named test collection; creation, readback and note update of one unique test bookmark; exact source-scoped bookmark delete preview/confirmation and known-empty test collection removal. The test bookmark was moved to Trash (the entire Trash was **not** purged). No pre-existing account item was modified or deleted; production remains v2.4.5 and PR #120 stays Draft pending the rest of #118/#119.

**Historical blocker — earlier 2026-09-20 attempt (resolved):** The branch now includes `scripts/test-direct-mcp.mjs` and an isolated GitHub Actions deployment with a per-run random `MCP_ACCESS_TOKEN`, a secret-file upload and direct authenticated `/mcp` checks (no Portal). [Run #35510822074](https://github.com/lirtual/mcp-workers/actions/runs/35510822074) stopped safely during credential preflight because the environment secret `RAINDROP_V3_TEST_ACCESS_TOKEN` was not available. No deployment or remote v3 MCP invocation occurred. The account token was not committed or printed. Grant the Cloudflare connector a usable action to bind the provided test token, or provision that token into the isolated GitHub Actions environment secret; neither needs an account-wide or production deployment.

**Historical blocker — earlier 2026-09-20 attempt (resolved):** Cloudflare management API successfully created the separate `raindrop-mcp-worker-v3-test` with a temporary 503-only initialization script. The user-supplied temporary `RAINDROP_ACCESS_TOKEN` was stored as a Secret on this test Worker; confirmed by a binding-name-only settings read. Attempts to initialize a separate `MCP_ACCESS_TOKEN` through the connected management action were blocked, so the v3 application was **not** deployed and `/mcp` was **not** tested. The production `raindrop-mcp-worker` was untouched. The temporary Raindrop token is still stored in the test Worker; rotate/revoke it when testing is finished or abandoned. The existing Actions workflow remains blocked by its absent GitHub environment secret until a supported credential-provisioning path is available. No account data was mutated.

**Extended direct-MCP evidence (2026-09-20):** [Actions #35512551236](https://github.com/lirtual/mcp-workers/actions/runs/35512551236) passed after a bounded authentication-propagation retry was added to the read-only initialize step. In addition to the preceding lifecycle it passed scoped `tag_list`, source-scoped `raindrop_bulk_update` with readback, and test-bookmark `highlight_create`, note-only `highlight_update`, preview/confirmed `highlight_delete` with fresh readbacks. Only test-created IDs were changed. The test bookmark was moved to Trash and its empty test collection deleted; no account-wide Trash purge was invoked. This is a partial #119 pass, **not** evidence for scoped cross-collection moves, tag rename/merge, plan-gated duplicate deletion, or Cloudflare resource ceilings.

**Cross-collection direct-MCP evidence (2026-09-20):** [Actions #35513029221](https://github.com/lirtual/mcp-workers/actions/runs/35513029221) passed on isolated v3 after read-only authentication propagation handling. A unique test run created collections A/B and two bookmark IDs. It verified a source-A bulk move to B, a wrong-source-A bulk update that did not change an independent B bookmark, correct-source-B bulk update and readback, and a single-bookmark move B to A. The run re-read the exact owned IDs and sources, moved **only** both test bookmarks to Trash and deleted both known-empty test collections. No existing bookmark, personal tag or entire Trash was modified. This is direct MCP evidence; Portal was not used.

**Scoped tag-write direct-MCP evidence (2026-09-20):** [Actions #35513162549](https://github.com/lirtual/mcp-workers/actions/runs/35513162549) passed after verifying every proposed UUID-suffixed test tag was absent from the global tag list. Within an owned collection/bookmark, the run previewed and confirmed a one-tag rename, a two-tag merge and an exact-tag delete, freshly reading back the bookmark after each operation and confirming the unaffected test tag remained. The same run reconfirmed highlight lifecycle and cross-collection scope isolation and cleaned only its own bookmarks/collections. This does not establish global tag-mutation safety for arbitrary existing tags.

**Nested collection and exact-ID Trash deletion (2026-09-20):** [Actions #35513312252](https://github.com/lirtual/mcp-workers/actions/runs/35513312252) passed direct MCP tests using a new UUID-labelled parent collection, child and bookmark. It checked the nested tree, exact child in parent-delete preview, fail-closed cycle and `parent=null` operations, fresh source in Trash, permanent preview and deletion of **only that verified test bookmark ID**, and confirmed the deleted ID cannot be read. Both known-empty test collections were deleted. This is **not** evidence that moving an existing child to root works; the `FEATURE_UNVERIFIED` gate remains closed. No global Trash purge occurred.

**Scoped live tag mutation evidence (2026-09-20):** [Actions #35513162549](https://github.com/lirtual/mcp-workers/actions/runs/35513162549) PASS. The isolated v3 Worker created one uniquely named test bookmark with UUID-suffixed test tags after checking the global tag list. Inside its owned collection it previewed/confirmed `tag_rename`, `tag_merge`, and `tag_delete`, re-reading the bookmark after each operation and verifying the separate retained tag was unchanged. The run then repeated scoped bulk update, owned highlight lifecycle and cross-collection isolation with targeted cleanup. No global-scope tag mutation, pre-existing tag or all-Trash purge was performed.

**Live remainder and recovery evidence (2026-09-20):** [Actions #35513757148](https://github.com/lirtual/mcp-workers/actions/runs/35513757148) passed exact-ID permanent deletion of a newly created test bookmark, parent/child collection create/readback, and fail-closed parent-to-root/duplicate write gates. Both `duplicates` and `broken` read-only audits returned `FEATURE_UNAVAILABLE` on this account; no operator semantics or Pro entitlement is inferred. A second, redundant nested test in the same run then encountered `RATE_LIMITED` and stopped before submitting deletion of its test bookmark. [Recovery #35514031332](https://github.com/lirtual/mcp-workers/actions/runs/35514031332) subsequently re-verified that exact bookmark's identity and source, moved it to Trash, permanently deleted only that ID, and removed the known-empty test child and parent collections. The workflow recovery-only marker was removed afterward. No pre-existing account item or whole Trash was deleted. Earlier successful smoke runs had deliberately moved their own test bookmarks to Trash without purging; **those items may still remain in Trash and must not be represented as fully cleaned**.

**Rate-limit and exact-ID recovery (2026-09-20):** [Run #35513757148](https://github.com/lirtual/mcp-workers/actions/runs/35513757148) reconfirmed direct smoke, collection/tag/highlight/cross-collection tests, plan-gated duplicate/broken reads (both `FEATURE_UNAVAILABLE`), parent/child, fail-closed parent-to-root/duplicate writes and exact-ID permanent deletion. A separate additional nested test then hit `RATE_LIMITED` and intentionally left its own bookmark and parent/child IDs for recovery, without guessing current source. [Recovery run #35514031332](https://github.com/lirtual/mcp-workers/actions/runs/35514031332) **passed**: re-identified that exact bookmark by ID/title/link/source, moved it to Trash, permanently deleted only that ID, and deleted the two verified empty test collections. It created no new objects and did not purge the account Trash. The temporary recovery-only marker was subsequently removed; regular live suites should not be retried repeatedly against the account due to its read-rate limit. Other earlier test bookmarks that were intentionally soft-deleted may still remain in Trash.

## Cloudflare runtime measurements — isolated test deployment (2026-09-20)

Queried Cloudflare GraphQL `workersInvocationsAdaptive` read-only, filtering exact `scriptName=raindrop-mcp-worker-v3-test` over 2026-09-20 00:00–16:00 UTC. Correlated `dimensions.scriptVersion` with the Cloudflare deployment endpoint; the most recently deployed 100%-traffic version is `44d7e535-1ef1-4136-871f-498dc6319b94` (deployed 13:37:37 UTC). This version predates subsequent #118 source changes and **does not measure current PR HEAD**. Values are observational percentiles, not worst-case resource maxima or a controlled load test.

| Metric (latest deployed version only) | Cloudflare result |
| --- | ---: |
| Invocation count | 13 |
| Worker runtime errors | 0 |
| CPU p50 | 11,046 µs = **11.046 ms** |
| CPU p99 | 44,843 µs = **44.843 ms** |
| Memory p50 | 19,544,726 bytes ≈ 19.54 MB |
| Memory p99 | 23,082,034 bytes ≈ 23.08 MB |
| `usageModel` dimension | `standard` (not proof of Free-plan entitlement) |

Cloudflare's current Workers Free HTTP CPU limit is **10 ms per request**, with **128 MB memory per isolate** (see [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)). The observed CPU percentiles are above the Free CPU limit, while measured memory is below its limit. Zero Worker errors does **not** certify compatibility with Free: the account's billing plan was not established from `usageModel`, and per-request CPU distribution/maximum, representative Free-plan enforcement, and full-load evidence are missing. **Do not mark the Free-plan resource gate as Pass or switch production for a Free-plan deployment based on this evidence.** No additional real-account write/load requests were made for this measurement.

## Current v3 source read-only CPU probe (2026-09-20)

[GitHub Actions #35518631508](https://github.com/lirtual/mcp-workers/actions/runs/35518631508) deployed branch SHA `9085c10318aaa577255060c81508e5fc9086e6b9` to the **isolated** test Worker only, yielding Cloudflare version `cb3b4b7a-504f-4571-974b-b18227c6a1c7` at 15:09 UTC. The direct `/mcp` probe passed HTTP health, unauthenticated 401, initialize, all 26 tool names, authenticated diagnostics, collection read and max-50 bookmark page. This run executed **no write or cleanup scripts**, used the already provisioned Raindrop Secret and a new short-lived transport token, and never used Portal. Cloudflare confirmed this exact version received 100% of the isolated test Worker's traffic.

Cloudflare GraphQL `workersInvocationsAdaptive` was queried read-only over 2026-09-20 15:08–15:30 UTC, grouped by exact `scriptVersion`. At the latest query, only **5 invocations** of the new version had appeared in the analytics dataset; this is a small, possibly ingestion-lagged observation, not a per-operation benchmark or worst-case maximum:

| Observed metric, new version only | Value |
| --- | ---: |
| Invocation records | 5 |
| Worker runtime errors | 0 |
| CPU p50 | **26,020 µs = 26.02 ms** |
| CPU p99 | **60,355 µs = 60.355 ms** |
| Memory p50 | 19,264,702 bytes ≈ 19.26 MB |
| Memory p99 | 19,665,752 bytes ≈ 19.67 MB |
| Observed `usageModel` | `standard` — billing entitlement not established |

The [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) reference lists 10 ms/request CPU for Free HTTP invocations and 128 MB/isolate memory. CPU measurements for the new version remain above this Free reference; measured memory is below its reference, but 5 invocations and zero errors do not demonstrate Free-plan compatibility, actual Free-plan enforcement or representative load. **Free-plan CPU release gate remains NOT APPROVED.** Do not extrapolate the older version's 13-call metrics to this new source. The next stage is a narrowly scoped CPU optimization/review followed by non-mutating, representative measurement; avoid rerunning the full real-account write suite or claiming this test covers production.

## Offline CPU breakdown (diagnostic only, 2026-09-20)

A **temporary** GitHub Actions profile ran a fake-token, no-network Node/Vitest benchmark of fresh per-request MCP registration and complete authenticated read-only Worker paths. This is an approximate `process.cpuUsage()` measurement on the CI runner, **not** Cloudflare's native CPU metric. It cannot certify Workers Free, and the individual groups cannot be simply summed.

| Offline operation | Samples | CPU p50 | CPU p95 |
| --- | ---: | ---: | ---: |
| Fresh `RaindropMCPService` construction / 26 tool registrations ([first run #35519108112](https://github.com/lirtual/mcp-workers/actions/runs/35519108112)) | 40 | 2.924 ms | 8.436 ms |
| `/health` ([complete-path run #35519179842](https://github.com/lirtual/mcp-workers/actions/runs/35519179842)) | 15 | 0.121 ms | 0.334 ms |
| Authenticated `initialize` (same run) | 15 | 5.579 ms | 11.273 ms |
| Authenticated `tools/list` (same run) | 15 | 6.595 ms | 10.262 ms |
| Fresh MCP Server construction in the second run | 40 | 2.384 ms | 7.467 ms |

**Interpretation:** even offline, MCP initialization/tool discovery is costlier than health; registration contributes but does not establish the cause of the earlier Cloudflare p50 **26.02 ms** (5 observed invocations). Cloudflare `workersInvocationsAdaptive` supports grouping by version/status but not the MCP JSON-RPC method. Cloudflare's deployed `performance.now()` timer does not advance during uninterrupted pure CPU work, so it is not an appropriate per-stage CPU timer ([performance docs](https://developers.cloudflare.com/workers/runtime-apis/performance/)). Do **not** share a mutable MCP Server across requests merely to eliminate registration: the server owns per-request credentials, execution budget, and transport state.

**Next resource gate:** determine the CPU cost of representative real, read-only `tools/call` operations for a version pinned to the final source; use Cloudflare-native per-invocation data and confirm the actual account plan. If CPU remains above Free's 10 ms/request limit, pursue a narrowly measured optimization before release. Do not repeat the full real-account mutation suite, claim these Node values are Free-plan numbers, or move production. The temporary benchmark test and one-off workflow were removed after recording the results; this document is the permanent evidence.

## Read-only smoke on the existing account (safe to run first)

This is explicitly opt-in, uses a local environment credential, and prints neither the credential nor personal item content. The source file is `tests/v3_live_readonly.test.ts`. It tests the app's MCP Client -> tool handler -> Raindrop API path, **not** a deployed Worker or Portal connection.

1. In the application directory, put **only** `RAINDROP_ACCESS_TOKEN` in the existing Git-ignored local `.env` (or supply it as a local environment variable). Never send it in chat, commit it, or store it as a GitHub Action log/argument. Do not reuse the Worker's `MCP_ACCESS_TOKEN` as the business API credential.
2. From that directory: `RUN_LIVE_API_TESTS=true pnpm run test:live:readonly`. In Windows PowerShell, set `$env:RUN_LIVE_API_TESTS = "true"`, then run `pnpm run test:live:readonly`.
3. Record date, tested commit, test case counts, account entitlement result, and failure codes **without** copying user profile, bookmark text, token or full URLs into the issue. If duplicate/broken filtering is plan-blocked it must be reported **Blocked**, never as a successful empty result.

Run the default `pnpm check` independently. The explicit live test is excluded from `test:local`, and the two unset/false gates cause it to skip on ordinary CI. An empty or large real account may still expose upstream-specific bounds; a read error must not be reclassified as success.

## Scoped write lifecycle — partially verified on test-owned objects

The current account is not an isolated disposable account, so the destructive operations below require tighter protections:

- [x] Generate a unique run prefix, e.g. `mcp-v3-acceptance-<run-id>`. Snapshot no personal content.
- [x] Create two private test collections A/B and record exact IDs; a separate live run also created a nested child, verified tree ancestry and safely deleted it.
- [ ] Create **new** test bookmarks with unique test links, notes and tags inside A only; record all IDs. Use only these IDs and collections for create/read/update/move/scoped delete and highlight lifecycle.
- [x] Test collection-scoped tag rename/merge/delete only with newly created globally unique test tag names; verified original absence and readback. Global tag writes on existing names remain out of scope.
- [x] Confirmed `parent=null` remains `FEATURE_UNVERIFIED` without a write and cycle moves fail closed. Actual parent-to-root write still blocked pending verified API serialization.
- [x] Source isolation: verify a test bookmark placed in B is unaffected by a source-A **bulk update**; source-A bulk-delete denial remains untested. Never probe with an existing bookmark ID.
- [x] Read-only duplicate/broken audit returned `FEATURE_UNAVAILABLE` on the current account; operator semantics remain unverified and `duplicates_delete(confirm=true)` is disabled. Do not infer an empty result or remove the gate.
- [x] Ran *specified-ID permanent deletion* for one freshly created, re-identified Trash bookmark; confirmed it is no longer readable. Do **not** run `trash_empty(confirm=true)` while the account Trash contains other entries; whole-Trash purge remains Not run.
- [x] Perform targeted cleanup of **only** returned test IDs for the first lifecycle run; verified the bookmark's source and collection's name/empty-leaf status before deletion. The test bookmark remains in Trash by design. Never use account-wide cleanup.
- [ ] Exercise deployed Worker/Portal discovery only after an approved v3 deployment: exact 26 tools, one safe read, authentication, redacted logs and Free-plan CPU/memory evidence. Direct local tests cannot satisfy this step.

## Evidence table

| Check | Status | Evidence / remaining blocker |
| --- | --- | --- |
| Offline 26-tool discovery and contract | Pass at last green CI SHA `fd77fda` | [CI](https://github.com/lirtual/mcp-workers/actions/runs/35507962617); recheck after later commits |
| Current-account direct MCP smoke | Pass (specified checks) | [#35511457233 attempt 2](https://github.com/lirtual/mcp-workers/actions/runs/35511457233): health, 401, initialize, 26 tools, authenticated diagnostic and collection page |
| Current-account scoped object lifecycle | Partial pass | [#35513312252](https://github.com/lirtual/mcp-workers/actions/runs/35513312252): owned nested collection, source-verified test-ID permanent deletion and cleanup; [#35513162549](https://github.com/lirtual/mcp-workers/actions/runs/35513162549): scoped tag writes; [#35513029221](https://github.com/lirtual/mcp-workers/actions/runs/35513029221): source isolation. Free-plan maxima and gated operations remain |
| Parent-to-root write | Blocked (fail-closed confirmed live) | [#35513312252](https://github.com/lirtual/mcp-workers/actions/runs/35513312252): `parent=null` rejected with `FEATURE_UNVERIFIED`; actual move not submitted |
| Duplicate deletion write | Blocked (fail-closed confirmed live) | [#35513757148](https://github.com/lirtual/mcp-workers/actions/runs/35513757148): `duplicates` and `broken` audits returned `FEATURE_UNAVAILABLE`; confirmed execution gate `FEATURE_UNVERIFIED` on test ID |
| Exact-ID permanent delete / entire Trash purge | Pass / Not run | [#35513757148](https://github.com/lirtual/mcp-workers/actions/runs/35513757148) and [recovery #35514031332](https://github.com/lirtual/mcp-workers/actions/runs/35514031332): verified test-only Trash IDs permanently removed. Other test-created soft-deleted items may remain; entire Trash never purged |
| Deployed direct Worker (no Portal) | Pass for test Worker only | v3.0.0 direct HTTP checks passed; production still v2.4.5; Portal never used |
| Free-plan resource measurements | Measured / **not approved** | [#35518631508](https://github.com/lirtual/mcp-workers/actions/runs/35518631508): current source read-only smoke passed; exact newly deployed version has 5 analytics records, CPU p50 26.02 ms/p99 60.355 ms, memory p99 ≈19.67 MB, 0 runtime errors; Free CPU reference is 10 ms/request. Sample, Free enforcement and full-load behavior are not established; older version 13-call values are preserved above. |

Every status must be updated from actual observations; preparing a test or passing mock CI does not turn a **Not run** or **Blocked** cell into a pass.


## Retrospective operation-level CPU attribution (2026-09-21 review of 2026-09-20 observations)

The Cloudflare Workers Observability telemetry API returned **individual invocation logs** for the prior isolated version `cb3b4b7a-504f-4571-974b-b18227c6a1c7`, UTC 2026-09-20 15:08–15:30. Exactly five successful authenticated `POST /mcp` invocation records appeared for that version. The previous aggregate CPU p50/p99 figures included these five calls, but did not identify their JSON-RPC methods.

Correlated the invocation timestamps with the sequential, *read-only* `scripts/test-direct-mcp.mjs` operations. As a cross-check, each log's Content-Length uniquely matches the UTF-8 byte length of that script's JSON-RPC body with a 36-character UUID; no personal data or token is needed for this correlation. Values below are platform-reported `$workers.cpuTimeMs` (rounded to integral milliseconds), **not** Node.js `process.cpuUsage`:

| Order | Request body bytes | Operation | Cloudflare CPU | Wall time | HTTP |
| ---: | ---: | --- | ---: | ---: | ---: |
| 1 | 213 | `initialize` | **60 ms** | 69 ms | 200 |
| 2 | 95 | `tools/list` | **46 ms** | 47 ms | 200 |
| 3 | 152 | `tools/call diagnostics`, `includeUpstream=true` | **26 ms** | 306 ms | 200 |
| 4 | 154 | `tools/call collection_list`, `perpage=1` | **20 ms** | 466 ms | 200 |
| 5 | 170 | `tools/call raindrop_list`, `perpage=50` | **20 ms** | 653 ms | 200 |

This is one sample per operation, not a statistical distribution or a measured CPU breakdown of individual functions. The 60 ms / 46 ms handshake and discovery records are evidence that non-upstream MCP work deserves investigation, **not proof** that tool registration specifically consumes those amounts. This version predates later #118 fixes and PR HEAD `210240ef`. Client and Cloudflare regions, cold/warm isolate effects, telemetry rounding, and per-operation repeatability are not controlled. The deployment and the account's `default_usage_model=standard` do not establish Free-plan entitlement or enforcement.

The same source branch now includes optional, non-secret `X-Raindrop-Profile-Op` labels and bounded additional *read-only* probes in `scripts/test-direct-mcp.mjs` (commit `1354a1b8`). This is **test preparation only**: do not claim that these new probes ran or that a final-HEAD Free-plan result exists. Default execution still performs the original read-only smoke. The test label header is generated from fixed method/tool enums, contains no user content or credentials and is not consumed by the Worker. No production change or real-account mutation is implied.

**Decision:** #119 CPU/resource gate remains **not approved**. Repeat isolated, version-pinned native per-invocation measurements for representative read-only operations on the final source, confirm actual Free entitlement/enforcement, and investigate observed hot paths before considering optimizations. Keep per-request MCP Server, credentials, and execution budgets isolated; don't share them without a separate safety proof. Do not rerun account mutations simply to profile CPU.
