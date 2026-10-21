## S3 Plan / Publish / Runner integration (Draft, 2026-10-21)

**New product code in S3 Draft PR #151** connects the previously isolated
S3 modules to the real Workflow MCP surfaces while keeping all production
flags **OFF**. `github.run` is supported as an explicit Plan Step with only
`with: {capability: heavy.github.echo}`; arbitrary command, repository, token,
endpoint, workflow ref or dynamic arguments are rejected by compilation.
`workflow_validate` reports `requires_heavy_execution_approval:true`.
Publish requires both `S3_ENABLED=true` in the server Environment and the
owner's explicit `approve_heavy_execution:true`, recorded in the immutable
Published Plan as `s3_execution_approved:true`. Mixed S2+S3 plans also
require S2's **separate** exact MCP read grant and risk acknowledgement.

The real `WorkflowRunner` executes a registered S3 Step using an immutable
D1 logical Attempt, one GitHub REST dispatch with
`return_run_details:true`, and a confirmed physical Run ID. No dispatch
occurs when S3 is disabled, and an ambiguous dispatch is
`s3_dispatch_unknown` **without retry**. The native Workflow waits outside
`step.do` and only consumes a signed claimed-owner callback after reading
the immutable D1 receipt. That verified output is available to downstream
`result.emit`. `/s3/claim` and `/s3/callback` are exact OIDC-only POST
endpoints and return 404 while S3 is disabled. A separate bounded echo-only
`.github/workflows/workflow-s3-executor.yml` runs with `id-token:write`
and repository read; **the job does not receive Cloudflare or Portal secrets**.
Callback origins and audience are server/GitHub Environment configuration,
never user Plan/Run inputs.

**Current acceptance is local product integration, not a new live deployment:**
Plan/Publish/Runner/HTTP ingress tests, including a combined S2+S3
publication contract, are green. Wrangler S3 product build dry-run passes.
The dedicated workflow is in a Draft branch and is not available on GitHub
main until separately authorized for merge. No S3 runtime flag, GitHub
dispatch secret, Cloudflare migration or callback origin was installed in
production. The previous real GitHub REST dispatch + OIDC + D1 callback +
native Workflow live evidence below used an **isolated test harness**.

**Outstanding gates:** execute a genuine S2 test Portal MCP call followed
by the newly integrated `github.run` in one isolated production-shaped
Cloudflare Workflow, confirm callback ingress and D1 migrations against
the dedicated executor workflow, and test timeout/cancellation and
lost-notification reconciliation. GitHub's default-branch workflow
registration and environment-scoped callback URL/token need an explicit,
minimal test setup; do not silently merge or turn on production S3.
The production Portal 401 is deferred until final rollout.

---

## S3 isolated independent GitHub REST dispatch proof (2026-10-21)

A real separate, side-effect-free GitHub Job has been dispatched successfully:
[coordinator Action #39627837142](https://github.com/lirtual/mcp-workers/actions/runs/39627837142)
→ [independent executor Action #39627918285](https://github.com/lirtual/mcp-workers/actions/runs/39627918285).
The GitHub REST `workflow_dispatch` request now sets
`return_run_details:true` (the upstream API requires this to obtain a
confirmed physical `workflow_run_id`). The coordinator pinned the exact
GitHub ref, registered an opaque logical Attempt, made **one** dispatch
request, recorded the returned physical Run ID in disposable D1, then
waited for that separate GitHub Runner to obtain its own signed OIDC
identity, claim the confirmed Attempt and execute only registered
`heavy.github.echo`. The callback was stored before Cloudflare Workflows
was notified, and the coordinator verified the Run's terminal result and
owner Run ID against D1. The child GitHub Action's final verdict was
**Success**, and the coordinator's main acceptance job finished **Success**,
including the isolated Worker/Workflow/D1 cleanup checks.

Because the dedicated `workflow-s3-executor.yml` is not present on the
repository's default branch, this **Draft-only isolated proof reuses the
existing `ci.yml` as a precisely pinned temporary executor**. The
production dispatcher remains pinned to `workflow-s3-executor.yml`; the
`ci.yml` alternate path is allowed only for exact
`lirtual/mcp-workers`, the S3 Draft ref and a randomly named
`workflow-s3-oidc-<10 hex>` isolated Worker. It does not authorize arbitrary
repository dispatch, Shell tools or dynamic callback URLs. The child Job
receives only opaque IDs and the scoped isolated hostname; it gets GitHub
OIDC but **not** Cloudflare or Portal secrets.

**Remaining product integration:** this proved a *GitHub Actions coordinator*
dispatching an independent Job and receiving its result through a real
Cloudflare Workflow. The user-facing Workflow MCP Runner and published
`Plan` DSL do **not** yet dispatch `heavy.github.echo`; this is not yet an
operational S3 MCP capability, nor a combined S1+S2+S3 plan through test
Portal. Cancellation, timeout ambiguity, cross-version compatibility and
the final dedicated executor workflow still require integration/acceptance.
S1 production unchanged, S2/S3 Draft and OFF, production Portal 401 deferred.

---

## S3 real GitHub OIDC / Cloudflare D1 isolated verification (2026-10-21)

[GitHub Actions #39624620984](https://github.com/lirtual/mcp-workers/actions/runs/39624620984)
completed **Success** on Draft head `c811565`. A GitHub-hosted Runner
minted a genuine GitHub OIDC token using `id-token: write`, then sent it
to a disposable Cloudflare Worker with dedicated disposable D1. The Worker
used the real `jose` GitHub JWKS verifier and D1 atomic Claim / immutable
callback receipt implementation; wrong-audience tokens and repeat Claims
were rejected, identical callbacks were idempotent, and an altered callback
was rejected. The test script queried real D1 to assert exactly one
confirmed physical owner and one stored callback result. Its successful
final job verdict includes removal of the isolated Worker and D1.

[Follow-up real Cloudflare Workflow proof #39625864994](https://github.com/lirtual/mcp-workers/actions/runs/39625864994)
also completed **Success** on `06cfd62`. The disposable fixture now
starts a real native Workflow, persists the authenticated callback before
sending `s3-receipt`, uses `sendEvent` / `waitForEvent`, and requires the
Workflow to re-read D1 before committing `runs.outcome='succeeded'`.
The coordinator polls actual D1 and asserts the returned business result;
the GitHub Action's overall Success includes exact Worker, Workflow and D1
removal. Event delivery without terminal D1 Run status would fail the job.

**Exact assurance scope:** the isolated GitHub CI Job registered *itself* as
the confirmed physical candidate using its `GITHUB_RUN_ID` and
`GITHUB_RUN_ATTEMPT=1` before requesting OIDC. The real platform proofs
now cover signed GitHub workload identity, D1 Claim, receipt-first callback
and native Workflow event wake/readback. They **do not** establish the
remaining full REST Workflow → separately dispatched heavy GitHub Job →
verified physical candidate correlation, durable production reconciliation,
or safe cancellation under ambiguity. The temporary `ci.yml` workflow
identity is server-pinned; the product dispatcher remains restricted to
`workflow-s3-executor.yml`. No production Worker/DB migration, new
production secret, merge or S3 activation took place. S2's **test Portal**
remains the intended source for later S1+S2+S3 integration; production Portal
HTTP 401 is deferred.

---

## S3 GitHub Actions execution (Draft, no release)

S3 is implemented in separate [Draft PR #151](https://github.com/lirtual/mcp-workers/pull/151)
stacked on S2 Draft #146. This first isolated security slice introduces
`s3-github-dispatch.ts` (only registered `heavy.github.echo` execution
requests, non-secret opaque inputs and dispatch-unknown without redispatch),
`s3-github-claim.ts` (GitHub JWKS RS256 OIDC JWT verification with pinned
issuer/audience/expiry/repository ID/ref/workflow/Run and run_attempt), and
`0003_s3_attempt_claim.sql` (one D1 logical Attempt row, confirmed physical
candidate and an atomic first-claim-wins UPDATE). `0004_s3_callback_receipts.sql`
and `s3-github-callback.ts` now persist one immutable signed-owner callback
fact before notifying Cloudflare Workflow. Identical callbacks are idempotent;
conflicts and late callbacks are rejected, while failed notification leaves
the durable receipt pending for reconciliation. This reuses D1, not a new
queue, callback service or broker. JWT verification uses the existing `jose`
library, now an explicit dependency, not a homegrown signing scheme.

The candidate returned by GitHub dispatch **must be durably confirmed in
D1** before a signed Runner is permitted to Claim. Neither a known attempt
ID nor a signed token from a different GitHub job is authorization. A timeout
or `dispatch_unknown` does not grant a second owner. No Cloudflare
migrations, workflows, secrets or production configuration have been changed.

Local signed-JWT/SQLite tests verify identity fences, single-owner Claim,
callback deduplication and lost-notification recovery. The repo's existing
Worker continues to compile under Wrangler dry-run with no S3 ingress enabled.
**Still missing**: a real GitHub-issued OIDC + Cloudflare D1 acceptance,
actual S3 HTTP Claim/callback ingress, native Workflow wake / readback and
bounded reconciliation, a controlled executor job, approved dispatch authority,
cancel/retry lifecycle, version compatibility, and production release approval.
No actual S3 heavy job has run. Until those gates pass, this is an
unconnected fail-closed module; S3 is NOT usable in production. S2 continues via the **test** MCP Portal and production
Portal authentication may remain deferred until final release.

---

## S2 Portal selection (Draft, not production-enabled)

- Isolated acceptance and tests continue using `https://test-mcp.lirtual.dpdns.org/mcp`.
- The proposed production target is `https://mcp.lirtual.dpdns.org/mcp`.
  A future production S2 release must **explicitly** configure
  `S2_PORTAL_ENDPOINT` to the production URL; it is not inferred from a
  Workflow Draft or a user-supplied Run input.
- Both endpoints are fixed in source. When the environment selects either one,
  the runtime rejects a Plan targeting the other endpoint before network I/O.
  The Portal Service Token is attached only to the selected exact URL; redirects
  and credential-header overrides remain denied. The existing generic
  owner-approved public-target path remains subject to its separate gates;
  this change does not claim generic SSRF isolation.
- Test-only Cloudflare Workers explicitly set `S2_PORTAL_ENDPOINT` to the
  test URL. Production S1 does not add this Variable and
  `S2_READONLY_ENABLED` remains absent/OFF.
- GitHub Actions' existing read-only Portal probe supports selecting `test`
  or `production` without changing Worker deployments, for credential and
  IMA tool discovery checks. It never stores or prints Service Token values.
- Production Portal Service Auth and IMA mapping must be positively accepted
  before a production S2 activation is separately authorized.

---

## S2 real test-Portal Cloudflare acceptance (2026-10-21)

The first exact owner candidate is `https://test-mcp.lirtual.dpdns.org/mcp`,
using the existing Access Service Auth policy and Environment secrets.
[Authenticated Portal acceptance #39589031472](https://github.com/lirtual/mcp-workers/actions/runs/39589031472)
passed initialize, tools/list and `ima_list_notebooks` without writing IMA data.

A separately named **isolated real Cloudflare Worker, Workflows and D1** then
completed `Draft → Validate → exact approve → Publish → Run → Result` through
that real Portal. Run `f9a359c0-a310-4ab6-95fc-b68f62e51b3c` returned
`succeeded` for both `read` and `emit` steps with an IMA result, and Run
idempotency passed. See [live Action #39591397557](https://github.com/lirtual/mcp-workers/actions/runs/39591397557).
The original Action itself ended **cancelled**, because the temporary Worker
cleanup command failed and lingering Node handles prevented the process from
exiting. This remains historical feature-execution evidence rather than a
successful CI verdict.

A targeted [cleanup Action #39593329741](https://github.com/lirtual/mcp-workers/actions/runs/39593329741)
then successfully removed and verified absence of the **exact** temporary
Worker `workflow-s2-ima-aab86c737a`, matching Workflow and D1. The
one-time cleanup job was removed afterward. The reusable isolated acceptance
script now uses the verified Cloudflare API delete and verifies absence
before exiting.

**Full final Cloudflare retest PASS (2026-10-21):**
[GitHub Actions #39596814131](https://github.com/lirtual/mcp-workers/actions/runs/39596814131)
on commit `1545a07` returned **Success**. The isolated owner Worker
`workflow-s2-ima-a78a6d2b8e` created its own D1/Workflow, successfully
completed the full S2 Draft → Validate → explicit approval → Publish → Run →
Result flow against `ima_list_notebooks` via test Portal. Run
`1036d51f-7e3f-46a9-aea0-49ff29c89320` had both `read` and `emit`
steps `succeeded`, with successful idempotency replay. Cleanup returned
`DISPOSABLE_CLEANUP_OK` for that exact isolated resource set and the
overall Action completed successfully. This is the first successful
**whole-job verdict**, superseding the previous cancelled job and proving
the revised cleanup path on the real edge.

**No production merge, deployment or S2 flag enablement.** The original
personal trusted-target residual DNS/IP risks remain accepted only in the
explicit limited scope; these results do not establish general SSRF isolation.

---

## S2 Portal machine authentication (Draft only)

The first owner-approved Portal candidate is
`https://test-mcp.lirtual.dpdns.org/mcp` (IMA through the existing Portal).
S2 is **disabled** in the checked-in Wrangler configuration and this Draft is
not authorized for production. S1 does not require the following settings.

When this S2 target is explicitly approved for enablement, configure the
optional Worker **secrets** `S2_PORTAL_CLIENT_ID` and
`S2_PORTAL_CLIENT_SECRET` with an Access service-token pair. The existing
`MCP_ACCESS_TOKEN` is an **incoming** credential and must not be reused as
a Portal outbound credential. Never put these values in a Workflow Draft,
logs, tracked files, or test fixtures.

The service token must have a Service Auth policy at **both** the Portal
Access application and the IMA linked-server Access application. For IMA's
Portal mapping, `Require user auth` must be **off** so the Portal uses its
stored upstream admin credential. Do not change other servers' mappings.
Only the exact Portal endpoint receives the service-token headers; all other
S2 targets receive no Portal identity. URL pinning and manual redirects are
not a proof of DNS/IP SSRF isolation. Exact endpoint + tool + schema-digest
Publish approval, risk acknowledgement, `readOnlyHint`, and the
`S2_READONLY_ENABLED` runtime gate remain required.

Authenticated test Portal discovery and the isolated S2 Workflow calling
`ima_list_notebooks` now have the evidence summarized above. Production
`S2_READONLY_ENABLED` remains OFF; do not enable it as a side-effect of tests.

# Workflow MCP Worker — S1 baseline, S2 candidate gated

Implementation base: [Issue #141](https://github.com/lirtual/mcp-workers/issues/141) and [S1 Draft PR #142](https://github.com/lirtual/mcp-workers/pull/142).
This branch also stages a **disabled-by-default S2 candidate** in [Draft PR #146](https://github.com/lirtual/mcp-workers/pull/146).
**Current release state (verified 2026-10-21):** S1 is already deployed
at `https://workflow.lirtual.dpdns.org/mcp` and passed the
[authenticated S1 production smoke #39579055871](https://github.com/lirtual/mcp-workers/actions/runs/39579055871).
The production `/health` returns HTTP 200 and `scope: s1`; an anonymous
MCP POST returns 401. S2 remains Draft, unmerged, un-deployed and
`S2_READONLY_ENABLED` absent/OFF in production. The **S2 pinned Portal URL
is the testing domain** `test-mcp.lirtual.dpdns.org`, not a production
Portal release decision. Enabling S2 requires a separate explicit release
authorization and target decision, not a manual test dispatch.

The S1 release preparation and earlier Draft/isolated evidence below are
**historical** and may refer to resources that had not yet been deployed
at the time of writing. The verified live status above supersedes them.

## S2 personal trusted-target decision B — 2026-10-21

- **Owner-approved scope change (B): personal trusted MCP targets only**, not unrestricted or verified-isolated dynamic targets. Each S2 Publish must first call `workflow_validate`, review the exact `required_approvals` (`endpoint`, `tool`, `scope: read`, `schema_digest`), then supply those exact values as `approved_operations` **and separately set** `accept_target_risks: true`. This acknowledges that the trusted target may access the wider network or perform side effects despite its claimed read-only metadata. No persistent target registry, new authentication layer, or approval service is introduced.
- The acknowledgement is retained in the immutable Published Plan as `s2_target_risks_accepted: true` alongside the exact grants. A legacy S2 Plan without that acknowledgement fails closed **before network**. This is an authenticated API-level assertion, not proof that a person independently interacted with a confirmation UI. The standalone `S2_READONLY_ENABLED` flag remains absent from Wrangler and **OFF**; the user choosing B does not authorize enabling it or deploying to production.
- `scopedPublicMcpFetch` enforces the approved exact URL and `redirect: 'manual'`. The `global_fetch_strictly_public` compatibility flag is **not enabled in the checked-in configuration**; it must not be claimed as an active protection. Neither URL checks nor redirect rejection prove DNS/IP/private-address/metadata or rebinding isolation.
- In a throwaway Cloudflare `wrangler dev --remote` preview, ordinary HTTPS returned 200; cross-origin redirect was denied; literal private/loopback/metadata IP URLs were rejected locally; private-IP-shaped DNS hostnames were **accepted** by the syntax gate and received HTTP 530. A 530 response cannot establish general private-network isolation. The preview was stopped, local files removed, and the named persistent Worker was absent.
- MCP `readOnlyHint` is **untrusted metadata**. Endpoint/tool/schema approval in `workflow_publish` is a matching application-level assertion, **not proof of a separate human confirmation event** or the target's side-effect safety. A lost acknowledgment after `tools/call` is recorded as `indeterminate` with `external_outcome_unknown`; no blind retries.
- **Original P0-3 / AC-08 SSRF-isolation criterion remains UNPROVEN; it is not marked PASS.** Decision B explicitly **narrows the acceptable use case** to targets the owner chooses to trust and knowingly accepts the residual private-network/metadata/DNS and third-party-tool side-effect risks. Retain the existing URL/redirect defense and SDK/schema checks as defense in depth; they are not an isolation guarantee. Do not add speculative DNS proxies, VPCs, gateways, or suffix blacklists just to relabel P0-3. **Production enablement and merge still need separate approval and a trusted-target acceptance check.**
- **Latest S2 checks:** at commit `db9578d`, **51/51 Node 24 tests PASS**, TypeScript and Wrangler dry-run PASS, and [GitHub CI #39558482188](https://github.com/lirtual/mcp-workers/actions/runs/39558482188) Application checks / GitGuardian PASS (release SKIPPED). The local owner-facing MCP SDK acceptance test covers Portal bearer and Origin denials, exact grant previews, rejected unapproved operations, immutable Publish, Run, Result, and token/service-binding separation. A prior disposable real Cloudflare edge run is independently documented below; neither test establishes arbitrary-network isolation or approves a third-party target.
- **Independent review completed:** two separate read-only Codex AI contexts reviewed the pinned S2 diff at `1eb99d9`: Security / Standards found no verified P0–P2 blocker; Functional / Spec reproduced one P2 where hanging optional remote MCP session DELETE could hide an already acknowledged `tools/call` success. A red/green regression and the minimal fix are committed at `db9578d`; earlier unresolved Run input arguments also fail before network. These are independently produced AI reports, **not GitHub-submitted Reviews or human approvals**. As verified on 2026-10-21, `main` has neither branch protection nor a repository ruleset requiring GitHub Review. No paid review product is a release prerequisite; future reviews should use the existing independent Codex workflow and actual CI results.
- **Actual remaining release gate is integration, not more review tooling:** S2 stacks on unmerged S1 [PR #142](https://github.com/lirtual/mcp-workers/pull/142). S1's [release-readiness record](S1-RELEASE-READINESS.md) confirms the D1 and GitHub Environment are prepared, while Workflow / Fixture deployment, live domain route and Actions release enablement remain outstanding. The existing `scripts/manual-worker-release.mjs` now exports a small **offline, fail-closed `verifyWorkflowReleaseConfig`** check for the future release path; it rejects placeholder D1 IDs, missing explicitly chosen Custom Domain, mismatched Workflows/Fixture bindings or secret declarations, and premature S2 enablement. The historical `readiness` CLI mode no longer exists in the production release script. Run its credential-free unit checks instead: `node --test scripts/manual-worker-release.test.mjs`. The actual release uses the existing guarded `preflight` / `readback` modes from `main`, not this Draft branch. The current configuration now has a **real, newly created empty production D1 UUID**, so offline static readiness can pass, but this is **not production deployment readiness**: live Workflow / Fixture and Custom Domain availability remain unverified or unprovisioned; D1 migrations are applied and directly verified; the inherited repository-level Portal credential has only been verified by Secret **name**, not plaintext or runtime acceptance. Workflow remains excluded from manual production dispatch. Even a passing offline result does not verify live D1 migrations, tokens, domain ownership or target safety. Before a first release, choose the intended production scope and **one concrete trusted MCP target** for owner approval; reuse the existing Actions release path and positively verify the initial D1 state. Merge, deploy, and enabling S2 each require separate explicit authorization. Do not add another deployment platform or start S3.

**Controlled real Cloudflare S2 trusted-target end-to-end proof (2026-10-21, implementation `1931288`):** An independently named **disposable** S2 Owner Worker (test-only S2 flag, randomly generated short-lived Portal Token), public read-only MCP fixture, Cloudflare Workflow and D1 applied the two existing migrations and passed **20/20 actual MCP SDK edge checks**. The test invoked Portal bearer rejection, SDK tool discovery, validation showing the exact endpoint/tool/scope/schema grant, rejection of missing `accept_target_risks` and mismatched grants, immutable Publish, real Cloudflare Workflows Run and remote HTTPS `echo` MCP tool execution, and returned the expected Result. Separately querying remote D1 confirmed Run `succeeded`, `read` and `emit` Steps both `succeeded`, and Wrangler listed the native Workflow instance as **Completed** (Run ID `ac1589fd-63b3-4e95-a6d1-308ae1e89f91`). After verification, **both Workers, Workflow, and D1 were deleted**: remote Workflow and D1 lists no longer contained the names, and both Worker version lookups returned Cloudflare **10007 / does not exist**. Local Wrangler configurations and disposable token were removed; no production resource or stored secret was used.

The reusable **manual** acceptance script is `tests/s2-edge-smoke.mjs`. Set `S2_EDGE_OWNER_URL` to a disposable isolated Owner origin, `S2_EDGE_TARGET_URL` to the exact disposable trusted MCP HTTPS endpoint and `S2_EDGE_ACCESS_TOKEN` to its disposable Portal test credential; run the script using Node 24. **Never point this acceptance at production.** This is genuine Cloudflare-edge behavior for an owner-controlled harmless target, **not** independent human confirmation, proof of SSRF isolation for arbitrary untrusted hosts, or acceptance of a real third-party MCP target. The original P0-3 / AC-08 guarantee remains unproven. No production enablement, merge or S3 is implied.

Platform references: [Cloudflare `global_fetch_strictly_public`](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public), [Workers fetch-to-IP known issues](https://developers.cloudflare.com/workers/platform/known-issues/#fetch-to-ip-addresses), [MCP tool annotations limits](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/).


## Boundaries

- Reuses the existing Portal bearer authentication on `/mcp`.
- YAML or JSON Drafts; optimistic revision CAS; atomic explicit Publish of immutable Plans.
- Finite DAG (32 nodes, at most 8 ready independent Steps), restricted references and conditions.
- Manual asynchronous Run ID; D1 and Cloudflare Workflows state and result.
- **Default-enabled S1 only:** `s1.readonly_mcp` / `echo` through a fixed private
  Service Binding, plus `result.emit`. The compiled `mcp.call` S2 candidate is
  runtime-gated and unapproved for use. No arbitrary external writes, Shell,
  code evaluation, webhook, Cron, OAuth, stored target credentials, or GitHub heavy execution.
- D1 Run admission idempotency, fixed instance IDs and bounded lookup after ambiguous create.
  S1 does not add an overflow queue, a second DAG engine or an external lock service.
- Runtime execution must not be labeled production-proven based on unit tests or local Wrangler alone.

## Setup for local smoke tests only

Use Node 24, `corepack pnpm install`, then
`corepack pnpm --filter workflow-mcp-worker run check`.
`check` runs typecheck, unit/contract tests and the existing `deploy:dry-run`
once; no production credentials are required. Do not repeat the dry-run afterward.

The Wrangler configuration deliberately contains an invalid placeholder D1 ID,
`workers_dev: false` and no production credentials. Never deploy that configuration as-is.

For local tests:
1. From the app directory, `wrangler d1 migrations apply workflow-mcp-worker --local`
   (use matching `--persist-to` for the dev server).
2. Start the read-only fixture with `wrangler dev --local --config tests/fixtures/wrangler.jsonc --port 8790`.
3. Start the S1 Worker with `wrangler dev --local --port 8787 --var MCP_ACCESS_TOKEN:<local-test-only-token>`.
4. Call `/mcp` with a matching local Bearer token; use `tools/list`, `workflow_create`,
   `workflow_validate`, `workflow_publish`, `workflow_run`, `workflow_status`
   and `workflow_result`. Never use real secrets or production D1.

Only two fixed app bindings are necessary: `DB` and `WORKFLOW`, plus
`READONLY_TARGET` for the isolated test seam. Actual deployment and live edge
validation need separate authorization.

## Result and status bounds

Step outputs and the final Run result are limited to **48 KiB of serialized UTF-8
JSON**. The complete MCP response remains capped at 64 KiB; the reserved 16 KiB
covers Run metadata and all 32 Step summaries (Step IDs are at most 64 ASCII
characters). An oversized Step output fails execution rather than creating a
successful Run whose result cannot be retrieved. An explicit `result.emit` of
`null` is retained as the result.

`workflow_status` and the metadata in `workflow_result` keep their existing field
shapes. `steps` now includes every Step from the Run's pinned Published Plan,
sorted by Step ID, with `step_id`, `status`, and nullable `error_code`. Completed
`succeeded`/`failed`/`skipped` projections are retained. A callback records
`running` in the existing `run_steps` table before execution; an unstarted Step
is shown as `waiting` (including dependency waits). On a terminal Run or native
`complete` (even while the business outcome settles), any Step without a confirmed
terminal projection is shown as `indeterminate`, never as still waiting or running.
Replaying execution does not reset terminal Step
projections. A nonterminal Run observed in native `waiting` also reports
Run `status: "waiting"`; D1 terminal outcomes remain authoritative. These are
additional status values and fuller Step coverage, with no new response fields.

## Evidence and remaining work

Local Wrangler E2E (2026-10-20), including the **current MCP SDK adapter**, passed
36 assertions at the Portal-authenticated MCP seam: Draft editing and invalid-Draft
preview, YAML readback, compile/Publish, concurrent identical Publish idempotency,
revision conflicts, pinned Run after republish, pause/replay, two successful read-only
MCP Steps and result retrieval, failed-dependency skipping and non-boolean runtime
conditions failing safely. The local-only `tests/local-e2e.mjs` needs both local
Wrangler processes and `S1_LOCAL_TOKEN` set to the same disposable auth token.

`tests/local-reserved-recovery.mjs` uses **isolated local D1 fault injection** (never
production D1) and passed: D1 reserved Run without a Workflow instance, same-ID
recovery, lost-ack reconciliation and explicit 8-slot capacity rejection.
A new aged-unknown fault case (11 minutes old) first fails on `run_capacity_exceeded`,
then passes after the fix: ingress admission reconciles the old instance ID,
marks an unconfirmed start `indeterminate` with `start_unconfirmed`, keeps the
original Run/idempotency key, releases its app capacity, and permits a fresh Run.
The same key never automatically creates a replacement instance; expired unknown
Runs cannot be silently rewritten to `succeeded` by a late Runner. Cleanup
removes injected capacity rows. Both programs are manual local integration suites,
not automatically invoked by ordinary unit tests.

**Isolated real Cloudflare edge evidence (2026-10-20):** a temporary, separately named
D1, S1 Worker, Workflows binding and private read-only fixture passed the same **32**
owner-facing MCP assertions through the current SDK. A remote-D1 fault injection
also passed: same-ID recovery of a reserved Run, lost-start-ack reconciliation,
and capacity-full admission rejection. A 15-second read-only fixture Step was
started and the isolated Worker redeployed while the Run was active; both Steps
subsequently succeeded with its original Published Version and expected output.
These are actual edge tests, not the local Wrangler simulator. The tests did not
exercise real network partitioning or all cross-engine incompatible migrations.

**Follow-up isolated Cloudflare edge evidence (2026-10-20, commit 4fa3849 and
isolated status-projection fix):** 36/36 public MCP end-to-end assertions passed.
Remote D1 fault injection also passed for an 11-minute-old `start_unknown` Run,
restored admission capacity, retained original idempotency identity, and
concurrent same-key new Run creation / old-Run status queries (no duplicate Run).
The edge test exposed a real Cloudflare/D1 visibility race: the Workflow native
status could be `complete` before the business outcome write became visible in D1.
Previously `workflow_status` prematurely returned `indeterminate`, even though
the Step's durable final state soon became `failed`. A failing contract test and
edge retry confirmed the fix: native `complete` alone does not establish the
business outcome; queued/running stays nonterminal while D1 settles. This new
fix has been proven against actual Cloudflare edge, not just local Wrangler.

**Latest isolated edge verification (2026-10-20, next S1 change):**
The new `0002_native_complete_seen.sql` migration was applied to disposable D1.
The strict Workflow lookup adapter was tested against the real edge exception
`(instance.not_found) Instance not found`; generic timeout, unavailable, and
substring-only errors remain **unavailable**, not evidence of absence.
The first remote D1 reserved-start replay correctly stayed `reserved` due to a
local-only missing-error spelling mismatch. A disposable authenticated diagnostic
endpoint established the exact edge marker, was removed, and the isolated
worker was redeployed without the probe. Subsequent **36/36 full edge MCP
assertions** and remote fault injection passed: same-ID reserved recovery,
lost-ACK reconciliation, capacity pressure and aged unknown starts, plus native
Workflow complete with a simulated permanently missing D1 business outcome.
The last case returns terminal `indeterminate` / `outcome_unconfirmed` only
after 10 minutes from **first seeing native complete**, never merely from Run
creation. A bounded ingress pass handles already-observed stale active Runs
without adding an independent scheduler.

**Remaining risk:** the exact Cloudflare missing-instance exception is an
observed **vendor runtime signature**, not a formally documented stable type.
If it changes, recovery fails closed to `start_unknown`, preserves the logical
Run and application capacity; it will not blindly dispatch. Real network
partitions and incompatible-engine-version migrations have not been simulated.
Two independent code reviewers remain outstanding. A final single-context
Standards/Spec audit also identified locale-dependent topological sorting of
independent Step IDs. Compiler sort now uses the same fixed character order as
canonical JSON; a red-to-green test checks mixed-case IDs and equal digests when
input Step order is reversed. The current tests include **17
S1 unit/contract tests** and the existing 38-assertion owner-facing local E2E checks.

**Final status semantics audit:** per Cloudflare's documented native states,
`errored` and `terminated` are terminal orchestration outcomes, but cannot prove
business-side effects were safely rolled back. If D1 still has a nonterminal
business outcome, record `indeterminate` with `orchestration_errored` or
`orchestration_terminated` and release S1 capacity, retaining the original Run
identity. Unit/contract tests cover this classification.

**Isolated Cloudflare native terminal proof (2026-10-20, commit `54e5e45`):**
a six-Step delayed read-only Run was **actually terminated** using Wrangler's
Workflow-instance API. The Portal-authenticated MCP result became
`indeterminate` / `orchestration_terminated`; replay of its original admission
key returned the identical Run ID. Separately, Wrangler started a Workflow
with a missing D1 Run payload and verified its actual native `errored` state
(`run_missing`). An isolated D1-only fault record with that exact UUID instance
ID and a nonterminal business outcome was then read through the public MCP API;
it became `indeterminate` / `orchestration_errored`. These are real native
Cloudflare states, with a deliberate D1 fault injection in the second case.
The previous 36/36 S1 public MCP edge assertions were rerun successfully.
Only temporary, separately named resources were used, and the D1, Workflow,
Workers and temporary test configuration/credential were deleted and checked.

Actual network partition, missing instances after native retention expiry, and
incompatible engine upgrade behavior remain unproven; the new tests must not
be described as exactly-once external-effect guarantees.

The temporary Cloudflare D1, Workflow, test Worker and fixture Worker were all
deleted afterward. The public test token and untracked deployment configuration
were removed locally; no production deployment or secret was modified. The optional
`S1_EDGE_REMOTE=1` fault-test path requires a freshly provisioned **isolated** D1
and a throwaway `wrangler.s1-cloud.jsonc` that is intentionally not committed.

Focused test-first review additionally closed two expression-safety gaps: references
may only access own data fields (not inherited JavaScript prototype members),
reserved Step IDs are rejected, and `if`/logical conditions require actual boolean
values rather than JavaScript string truthiness. S1 now has 17 unit/contract tests. A later final review also rejects YAML non-finite numbers (`.nan`, `.inf`) before JSON canonicalization (avoiding silent `null` conversion), and normalizes Run input-object key order before computing the admission idempotency digest. Canonical Plan and Run hashes use locale-independent key comparison, avoiding runtime-locale-dependent hashes.

**MCP Tool metadata audit:** `workflow_status` and `workflow_result` can reconcile
an already admitted Run, write D1 and start its original deterministic Workflow
instance. They must not advertise `readOnlyHint: true`; both now accurately
report `readOnlyHint: false`, `idempotentHint: true` and disclose reconciliation
in their descriptions. This is an annotation/contract fix, not a new execution
path. Local SDK tool-list and execution regression: **38/38 assertions passed**;
the cloud-edge **36/36** evidence above applies to the earlier tool metadata.

**Independent DAG Step progression acceptance (Issue #141 story 15, 2026-10-20):**
The existing owner-facing MCP E2E now proves that two ready read-only Steps
actually progress concurrently: one fixture deliberately waits nine seconds,
while the unrelated fast Step reaches persisted `succeeded` before the slow Step
finishes; both eventually succeed. **40/40 MCP SDK assertions passed locally and
on a real isolated Cloudflare Worker/Workflows/D1/fixture deployment.** This
closes a specific parallelism evidence gap, not an implementation feature gap.
The disposable Worker, Workflow, fixture and D1 were deleted and absence from
remote D1/Workflows lists verified; local test secrets/config were removed.
Real Cloudflare internal control-plane partition and incompatible engine upgrades
remain unproven; this test does not claim either.

**UTF-8 payload boundary audit (2026-10-20):** Input Draft size and compiled
YAML/JSON size must be capped in **UTF-8 bytes**, not JavaScript code units;
MCP response serialization must enforce its 64 KiB limit the same way.
A red-to-green public-MCP test exercises a long multibyte Chinese Draft that
was previously admitted despite exceeding 32 KiB, and a contract test covers a
multibyte response beyond 64 KiB. Updated local evidence: **41/41 owner-facing
MCP assertions, 18/18 unit/contract tests** and reserved-instance/recovery
fault injection passed. This is a data-boundary bug fix only; it does not alter
S1 scope or any Cloudflare execution architecture. The 41-assertion suite has
not been rerun on real edge for this particular revision.

**Final input-type validation (2026-10-21):** S1's fixed `s1.readonly_mcp`
`with.arguments` must be an object (a valid structured `ref` expression remains
allowed). Previously numeric, null, string or array values could be Published
and fail only at execution time. This was reproduced by a failing compiler test
and repaired with one validation check. Local validation/Publish MCP regression:
**42/42 E2E assertions**, **19/19 unit/contract tests**, and same-ID recovery /
capacity fault injection passed. The change requires no extra service or D1
migration. The new case is locally tested, not independently edge-retested.

**Retention-expired instance / lost-ACK business outcome regression (2026-10-21):**
An injected historical Run with no native Workflow instance, a lost start ACK
(`start_unknown`) and a known D1 `succeeded` business outcome previously reported
`start_unknown`, concealing the durable result. The public MCP red→green test
now verifies `workflow_status`, `workflow_result` and original-key replay report
D1's actual terminal outcome while preserving the unresolved start ACK and never
creating a replacement instance. When the native instance is still found, normal
start-ACK reconciliation remains intact. Local **42/42 MCP E2E** and **19/19
unit/contract** tests, plus the extended D1 fault suite, passed. This is local
fault-injection evidence, **not** proof that an actual instance was aged past
Cloudflare's retention window on the live platform.

**Concurrent admission capacity acceptance (2026-10-21):** A new public-MCP
local E2E case concurrently submits **16 different idempotency keys** across
**two Published Workflows**, alternating targets with identical 15-second
read-only Steps. Exactly **8 Runs are admitted across the whole application**,
all 8 excess requests return `run_capacity_exceeded`, and all 8 admitted Runs
eventually succeed. The earlier same-Workflow test is thus strengthened to prove
that the 8-slot cap is global, not 8 slots per Workflow. The existing local suite now passes **45/45
owner-facing MCP assertions**; the D1 lost-ACK/reserved-start/capacity recovery
fault suite, **19/19 S1 unit/contract**, Portal Auth **6/6**, selector **6/6**,
TypeScript and Wrangler dry-run also pass. This is **local Wrangler D1
concurrency evidence**, not a new real Cloudflare-edge stress test; it adds
no runtime code, queue, scheduler or second execution system.

Final initial-release versus active-upgrade gate decisions and 27-story evidence
are consolidated in [S1-RELEASE-READINESS.md](S1-RELEASE-READINESS.md).

Still required before closing S1: final standards/spec code review, applicable
network interruption acceptance and explicit merge/release authorization.
S2 contains only the gated candidate above; S3 is not implemented.

Q1–Q50 design remains in [Draft PR #135](https://github.com/lirtual/mcp-workers/pull/135);
new S2/S3 facilities are not to be provisioned here.
