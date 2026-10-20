# Workflow MCP S1 — release-readiness decision record

Scope: Issue #141, Draft PR #142, compared with `origin/main...d8eb1f2`. This is an **evidence and gate record**, not another design spec, new Ticket, or production authorization. Keep Q1–Q50 design in Draft PR #135. Re-evaluate HEAD and current CI whenever the implementation changes.

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

Latest local evidence for `d8eb1f2`: **41/41** owner-facing MCP assertions, **18/18** S1 unit/contract tests, **6/6** Portal Auth, **6/6** selector tests, fault-injection suite, TypeScript and Wrangler dry-run pass. Earlier real isolated Cloudflare evidence: **40/40** MCP assertions at `e807b50`, including independent Step progress; native `errored` and `terminated` at `54e5e45`; no real edge deployment of `d8eb1f2`. Isolated test resources were deleted. These are different evidence scopes, not interchangeable CI/edge claims.

## Gate decisions

| Gate | S1 first deployment (empty state) | Later deployment with active Runs |
| --- | --- | --- |
| **Latest-commit CI** | Mandatory green (including app, database, security checks). Do not infer from old SHA | Mandatory green |
| **Independent code review** | Two genuinely independent Standards/Spec reviewers per Matt Pocock workflow. **Not satisfied:** PR #142 has no formal review submissions. One-context audit is not a substitute | Review any changed failure/upgrade semantics |
| **Authorization & credentials** | Explicit user approval for merge/release; verify Portal token, real D1 binding, Wrangler Workflows fixture separation and no open public target. Initial production D1 must be empty of old active Runs | Same plus check active versions/Run state and rollback strategy |
| **Incompatible execution engine upgrade** | **Not applicable only if zero old active Runs are positively verified.** No prior engine version is active in a genuinely new installation | **Mandatory** compatibility proof or refuse/postpone deployment until active Run safety is established. Never silently reinterpret old Plan/Step IDs |
| **Real network partition** | Not mechanically required as an uncontrollable Cloudflare internal event for read-only S1 preview. Conservatively handle `unavailable` as `start_unknown`, never blind retry; known-API failures and lost ACK are tested. Explicitly accept temporary quota blockage and operational intervention on persistent outage | Reassess before external writes or stronger availability guarantees |
| **Retention-expired Workflow instance** | D1 persisted business result is canonical. A nonterminal D1 record whose Workflow instance disappears after platform retention remains **uncertain** and may hold capacity; do not equate missing with failed or re-execute it | Require a controlled triage/recovery plan if actual retained-state loss emerges. No automatic mass cleanup or extra scheduler in S1 |

**Platform facts:** Cloudflare Workflows finished instance state has bounded retention; Free is limited to 3 days, Workers Paid has an up-to-30-day maximum but, for Workflows newly created since 2026-09-10, the default on Paid is 7 days unless overridden. These are **instance-observability windows**, not a safe cutoff for D1 Run identities. See [Workers API](https://developers.cloudflare.com/workflows/build/workers-api/) and [retention changelog](https://developers.cloudflare.com/changelog/post/2026-09-10-paid-retention-default/). Workers deployments version code/bindings but **do not version D1 storage**; see [Workers versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/).

## Current release recommendation

**Not yet ready to mark PR #142 Ready, merge, or deploy** because latest-commit CI and independent reviewers are not both verified; user explicitly prohibited merge/production deployment.

Do **not** make real internal Cloudflare network outages or a hypothetical incompatible *future* upgrade a blocker to the **first empty-state, read-only S1** deployment after those gates and explicit authorization. If production state is not empty, reassess as an active-Run upgrade, not a first deploy. If the platform error signature changes, the implementation intentionally fails closed; preserving capacity and returning uncertainty is preferable to replaying a possibly executed Run.

Remaining risk disclosures: bounded 8-slot capacity may be held during persistent lookup outage; retention-expired unresolved instance needs manual triage; external effects are out of scope; no exactly-once side-effect guarantee. Do not add a queue, scanner, scheduler, new token authority, or broad public MCP connectivity to address these hypothetical issues.
