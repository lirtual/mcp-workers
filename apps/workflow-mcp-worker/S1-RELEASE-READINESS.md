# Workflow MCP S1 — release-readiness decision record

Scope: Issue #141, Draft PR #142, preflight against `e5fcbab` (2026-10-21). This is an **evidence and gate record**, not another design spec, new Ticket, or production authorization. Keep Q1–Q50 design in Draft PR #135. Re-evaluate HEAD and current CI whenever the implementation changes.

## S1 user-story coverage

| Issue #141 stories | Observable S1 evidence | Assessment |
| --- | --- | --- |
| 1–4 (Draft, list, get, expected revision) | Portal-authenticated MCP SDK local/isolated-edge E2E, revision conflict checks | Implemented, tested |
| 5–7 (DAG/expressions, side-effect-free validation) | Rejection and typed-condition unit/contract tests; unsupported operations fail before dispatch | Implemented, tested |
| 8–10 (atomic explicit Publish, canonical digest, Draft isolation) | Concurrent Publish, rejected Publish retaining existing version, deterministic Plan/Step ordering, fixed Published Version | Implemented, tested |
| 11–14 (async admission, idempotency, capacity, pinning) | MCP E2E and D1 fault injection, same-ID replay, eight-slot explicit rejection, pinned Run after republish | Implemented, tested |
| 15–16 (bounded parallelism, dependency failure) | Real Cloudflare two-Step slow/fast overlap, 40/40 edge assertions at earlier SHA; dependency failure skips downstream | Implemented, tested |
| 17 (deterministic conditions/restarts) | Typed conditions, pinned Plan, deterministic step names, same-version redeploy; **not** incompatible live-engine upgrade | Implemented for S1; upgrade gate remains |
| 18–19 (truthful states, bounded safe output) | Native errored/terminated real-edge tests, D1 settlement tests; UTF-8 byte-boundary tests local at d8eb1f2 | Implemented; new byte fix edge retest not required for initial empty deployment |
| 20 (paged/redacted lifecycle, where present) | S1 exposes only bounded Run/Step status, not a general event-feed or audit pagination API | Conditional scope: no feed implemented or required |
| 21–22 (isolated read-only MCP fixture, no unsafe targets) | Cloudflare MCP SDK edge E2E and unsupported-target negative validation | Implemented, tested |
| 23–24 (ambiguous start, orchestration vs business outcome) | Original deterministic ID, lost acknowledgment, aged unknown capacity recovery, native complete/D1 stale settlement; fail-closed transient lookup unit test | Implemented for observed cases; real internal partition remains an external risk |
| 25–27 (one owner-MCP seam, no S2/S3, no extra scheduler) | SDK E2E + static PR diff; only Portal Auth, D1, Workflows and private fixture | Implemented, scope respected |

Latest implementation evidence at `e5fcbab` (2026-10-21): **27/27** S1 unit/contract tests, **45/45** Portal-authenticated MCP local E2E assertions, TypeScript, Wrangler dry-run and [CI run #39521365172](https://github.com/lirtual/mcp-workers/actions/runs/39521365172) all passed. Two *independent AI review contexts* examined Standards and Spec at `0e31df9`, followed by two fresh review contexts of the fixes at `e5fcbab`. Standards' three P2s were closed; Spec's Step-state P2 was closed, while a **conditional old-active-Run compatibility risk** remains for upgrades. All findings are in the existing [PR #142 review handoff](https://github.com/lirtual/mcp-workers/pull/142#issuecomment-6296365160); **zero formal GitHub reviews submitted**. Earlier isolated Cloudflare edge E2E **40/40** at `e807b50` (and native terminal status at `54e5e45`) is earlier-SHA evidence, **not a real edge retest of `e5fcbab`**. Local test processes and temporary worktree were cleaned after validation.

## Gate decisions

| Gate | S1 first deployment (empty state) | Later deployment with active Runs |
| --- | --- | --- |
| **Latest-commit CI** | **PASS** at `e5fcbab` ([run #39521365172](https://github.com/lirtual/mcp-workers/actions/runs/39521365172)); recheck if HEAD changes | Mandatory green |
| **Independent code review** | Two separate AI review contexts and two fresh fix re-reviews **completed** and documented. GitHub submitted Reviews/approvals remain **0**; do not conflate them with independent AI reports. New conditional compatibility finding must be gated by active-Run state | Review any changed failure/upgrade semantics |
| **Authorization & credentials** | Explicit user approval for merge/release; verify Portal token, real D1 binding, Wrangler Workflows fixture separation and no open public target. Initial production D1 must be empty of old active Runs | Same plus check active versions/Run state and rollback strategy |
| **Incompatible execution engine upgrade** | **Not applicable only if zero old active Runs are positively verified.** No prior engine version is active in a genuinely new installation | **Mandatory** compatibility proof or refuse/postpone deployment until active Run safety is established. Never silently reinterpret old Plan/Step IDs |
| **Real network partition** | Not mechanically required as an uncontrollable Cloudflare internal event for read-only S1 preview. Conservatively handle `unavailable` as `start_unknown`, never blind retry; known-API failures and lost ACK are tested. Explicitly accept temporary quota blockage and operational intervention on persistent outage | Reassess before external writes or stronger availability guarantees |
| **Retention-expired Workflow instance** | D1 persisted business result is canonical. A nonterminal D1 record whose Workflow instance disappears after platform retention remains **uncertain** and may hold capacity; do not equate missing with failed or re-execute it | Require a controlled triage/recovery plan if actual retained-state loss emerges. No automatic mass cleanup or extra scheduler in S1 |

**Platform facts:** Cloudflare Workflows finished instance state has bounded retention; Free is limited to 3 days, Workers Paid has an up-to-30-day maximum but, for Workflows newly created since 2026-09-10, the default on Paid is 7 days unless overridden. These are **instance-observability windows**, not a safe cutoff for D1 Run identities. See [Workers API](https://developers.cloudflare.com/workflows/build/workers-api/) and [retention changelog](https://developers.cloudflare.com/changelog/post/2026-09-10-paid-retention-default/). Workers deployments version code/bindings but **do not version D1 storage**; see [Workers versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/).

## Read-only release preflight — 2026-10-21

Checked only via authenticated GitHub metadata and `wrangler` read/list commands on the existing authorized WSL device. **No Cloudflare resources, GitHub Secrets, workflow runs or deployment settings were created or changed.**

| Gate | Verified observation | Consequence |
| --- | --- | --- |
| Existing S1 Worker | `workflow-mcp-worker` deployment lookup returned Cloudflare **10007 / does not exist** | No existing S1 deployment in the checked account |
| Existing Workflows/D1 | Account lists no `workflow-mcp-s1` Workflow and no D1 database called `workflow-mcp-worker`; only an unrelated Workflow is listed | This is consistent with a *new* S1 installation, but does not itself prove a D1 Run row count from a nonexistent database. If an alternative historical S1 state is claimed, identify/query its exact DB before upgrade |
| Fixed read-only fixture | `workflow-s1-readonly-fixture` Worker lookup returned **10007 / does not exist** | The current `READONLY_TARGET` binding cannot function as configured; test fixture is not production-provisioned |
| S1 Wrangler config | D1 ID remains all-zero placeholder, `workers_dev: false`, `preview_urls: false`, no route/custom domain; required Portal `MCP_ACCESS_TOKEN` source not configured for S1 | **Hard deployment blocker**; dry-run is only a bundle/binding-shape test |
| GitHub Environment | Existing worker-specific Environments do **not** include `workflow-mcp-worker` | No verified S1-scoped release Variables/Secrets; never infer credential presence from another Worker |
| Existing release automation | `.github/workflows/ci.yml` manual deploy allowlist and `scripts/manual-worker-release.mjs` both limit release to six existing Workers, not S1; the existing verification assumes a Workers.dev MCP endpoint | Current automatic release flow cannot deploy/verify S1. Do not bypass this gate with ad-hoc production Wrangler commands |

**Decision:** **STOP at release-selection gate.** S1 remains a read-only fixed-fixture implementation; production enablement needs a deliberate approved rollout target, real D1/Workflow/service/Portal bindings, an endpoint strategy and adaptation of the **existing** release/verification path if production is actually desired. Do not blindly add S1 to its allowlist: D1 migrations, Workflows and fixture/route acceptance differ from the six existing workers. Do not provision a permanent private fixture, issue another token, invent a queue/scheduler or create a second deployment system merely because those are technically possible.

For a genuinely empty first installation, positively validate the newly chosen D1 before admitting Runs. For any discovered prior active Runs, **halt incompatible upgrade**: the latest 48 KiB limit may change execution semantics of an older pinned Plan/Run. This is a **conditional upgrade risk**, not proof of an already deployed old S1 engine.

## Current release recommendation

**Not yet ready to mark PR #142 Ready, merge, or deploy.** Latest-commit CI and independent AI review evidence are now verified, but the Cloudflare deployment resources, release route and GitHub Environment are not provisioned, there is no real edge retest at `e5fcbab`, and the user has **not authorized merging or production deployment**. A green CI or separate AI audit is not a production release.

Do **not** make real internal Cloudflare network outages or a hypothetical incompatible *future* upgrade a blocker to the **first empty-state, read-only S1** deployment after those gates and explicit authorization. If production state is not empty, reassess as an active-Run upgrade, not a first deploy. If the platform error signature changes, the implementation intentionally fails closed; preserving capacity and returning uncertainty is preferable to replaying a possibly executed Run.

Remaining risk disclosures: bounded 8-slot capacity may be held during persistent lookup outage; retention-expired unresolved instance needs manual triage; external effects are out of scope; no exactly-once side-effect guarantee. Do not add a queue, scanner, scheduler, new token authority, or broad public MCP connectivity to address these hypothetical issues.
