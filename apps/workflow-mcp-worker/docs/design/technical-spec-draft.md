# Workflow MCP — Consolidated Technical Specification (DRAFT)

**Date:** 2026-10-20  
**Status:** Proposed implementation contract for review; **not implementation authorization**  
**Source of decisions:** Grill With Docs Q1–Q50 in [decision log](grill-with-docs.md); [domain vocabulary](../../CONTEXT.md); [ADRs](../adr/)  
**Change authority:** Documentation-only Draft PR #135. No source code, infrastructure, credentials, Tickets, merge, or deployment authorized.
**Adversarial review revision (2026-10-20):** H1–H8 below clarify execution safety, admission consistency and staged delivery. These are technical proposals and proof obligations, **not additional approved Q decisions**.
**Further isolated cloud fault-window evidence (2026-10-20):** [Broken response stream, cross-version waiting Run, and public Worker HTTPS connectivity](p0-cloud-fault-windows-20261020.md) verified a real remote response-body stream abort after commit (guarded 1 effect vs unguarded 2), v1-to-v2 deployment while a Workflow waited (existing Run finished under v1), and one safe public Worker-to-Worker HTTPS path. P0-3 SSRF adversarial probes, MCP protocol era interoperability, actual client-disconnect/create races, isolate termination and incompatible upgrades remain **OPEN**. All temporary cloud resources were deleted.\n\n**P0 feasibility evidence (local and cloud isolated, not full production acceptance):** [Local P0 evidence](p0-local-poc-evidence.md) and [isolated real Cloudflare P0 evidence](p0-cloud-poc-evidence.md) reproduce duplicate remote effects without a dispatch guard, show one effect with a guard, and reconcile simulated create acknowledgement loss. **Six cloud scenario groups passed**, but real connection interruption, isolate termination, retention expiry and deployment/replay compatibility remain unverified. Do not equate these tests with full AC-23–AC-26 completion.

## How to read this specification

- **DECIDED**: directly follows an owner-confirmed Q1–Q50 choice. These are non-negotiable without explicitly reopening the corresponding question.
- **PROPOSED**: precise field name, JSON structure, database layout, timeout, numerical limit or operational method suggested so the contract can be implemented and tested. **Not owner-approved yet**.
- **VERIFY**: platform/API assumptions to establish experimentally or against authoritative documentation before implementation.
- **BLOCKER**: an unproven safety/correctness property that must fail closed and prevent production side-effecting runs until verified.

This document is one integrated draft rather than multiple competing specs. Prior v0.1 ideas are not adopted by implication. In particular, Git-only definitions, preregistered-only MCP connections and read/run-only tools are superseded by Q5=B, Q7=B and Q36=A.

## 1. Product boundary and architecture

**DECIDED (Q1–Q10, Q18, Q26–Q27, Q34):** MCP-native, AI-first, single-owner, independent `apps/workflow-mcp-worker` context in the existing monorepo. Runtime-owned definition authoring; bounded DAG; Cloudflare Workflows owns durable progression. D1 holds definitions, immutable plans, coordination/query facts, encrypted target credentials and small outputs; R2 holds large Artifacts. GitHub Actions runs only registered heavy capabilities and remains separate from the existing GitHub Actions *management* MCP.

Proposed logical dataflow:

~~~text
ChatGPT / MCP client
  -> Worker auth + atomic owner-facing tools
  -> D1 Draft -> validate + authorize + compile -> immutable Published Plan
  -> Manual / authenticated Webhook / scheduled ticker -> Run admission (D1 CAS)
  -> Cloudflare Workflow instance -> DAG steps
       -> dynamic safe Streamable HTTP MCP target (per-target credential + tool grant)
       -> registered GitHub Actions heavy capability (independent dispatch credential)
  -> step facts + outbox/inbox receipts -> D1 status/events
  -> small result: D1; large Artifact: R2
~~~

**Non-goals:** general n8n UI, arbitrary JavaScript/shell from the DSL, static required MCP host registry, a second DAG scheduler, Redis/BullMQ, custom Saga rollback, multi-tenant RBAC, a separate Vault, an unbounded dynamic fan-out platform or arbitrary internal Attempt CRUD exposed via MCP.

### 1.1 Single source of progression

Cloudflare Workflows alone decides when a DAG Step may advance; D1 records admission, identity, immutable plan, claims, callback facts, query projections and results. D1 is not an independent step scheduler. Worker cron admission for dynamically managed schedules is trigger ingress, **not** a second DAG engine.

**VERIFY/P0:** Cloudflare Workflows requires deterministic durable step names and may replay logic on wake/redeploy. Prove that this interpreter compiles stable step identifiers and does not reissue an already-completed side-effecting operation. See [Rules of Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/) and [Workflows Workers API](https://developers.cloudflare.com/workflows/build/workers-api/).

### 1.2 Public identities

**PROPOSED:** `workflow_id` is immutable; a mutable Draft carries `draft_revision`. A `published_version_id` identifies an immutable compiled plan and has its own `plan_digest` and `plan_format_version`. Each `run_id` permanently references one published version; each `step_id` is unique inside the plan; `attempt_id` belongs to a specific Run+Step; a GitHub physical job is a *candidate*, not the logical Attempt. Use opaque IDs, not human names, for matching or authorization.

### 1.3 Minimum-entity rule — owner-confirmed design-review constraint (2026-10-20)

**Principle:** every new persistent entity, long-lived secret, background service, privilege surface or abstraction must state (1) the distinct invariant that current Portal/Workflows/D1/GitHub cannot uphold, (2) simpler reuse alternatives, (3) lifecycle/rotation/recovery and maintenance cost, and (4) a test proving its necessity. **Default: do not introduce it.** This constrains implementation selection; it does **not** reopen Q1–Q50, waive security requirements, or authorize code changes.

| Existing responsibility | Reuse | New component? |
| --- | --- | --- |
| MCP owner/client ingress | `packages/portal-auth`; existing Portal bearer/Origin boundary (Q10) | **No** second login, RBAC or token authority |
| GitHub-hosted job identity for Claim/callback | GitHub-issued, short-lived OIDC JWT + verification **inside** Workflow MCP (Q26) | **No** homegrown per-Attempt token issuer, vault, OAuth server, independent OIDC service or persistent JWKS table |
| Unique authorization to execute an Attempt | One conditional D1 owner claim **within the existing logical Attempt model** (Q26) | **No** standalone lock service or separate Claim microservice |
| Receipt-first callback | Existing D1 receipt state and Workflow notification (Q48) | **No** event broker or extra callback-processing daemon |
| GitHub workflow dispatch | Bounded GitHub REST/Actions execution (Q18), with **distinct least-privilege execution authority** (Q27) | **No** extra dispatch Worker by default; **do not** casually share the management MCP's multi-PAT power |
| Arbitrary routine MCP Steps | Existing Workflows orchestration, Portal owner grants and target-scoped credentials | **No** GitHub OIDC requirement unless the Step actually runs in GitHub Actions |

**Important distinction:** the already-existing GitHub Actions management MCP can supply shared *REST client code, request/correlation logic and implementation experience*. Automatically calling that management Worker with its owner Portal token or passing its pooled multi-account `GH_TOKEN` into Workflow MCP would broaden privileged dispatch authority and conflict with Q27. Reuse the implementation first; delegate actual dispatch to the existing service **only if** an independently reviewed, capability-scoped call can uphold Q27 without exposing its broader token pool. If that cannot be proven, a single minimal-scope workflow-dispatch credential may be justified; assess and document its repository/workflow access, secret location and rotation before creating it. This does **not** authorize provisioning credentials now.


## 2. DSL and immutable executable plan

**DECIDED (Q2, Q5–Q6, Q11–Q12, Q38, Q40–Q42, Q45):** YAML or JSON declarative definition, runtime Draft authoring, optimistic edits, validation plus required authorization then atomic Publish. Publish compiles a fixed plan. No `eval`, custom JS functions, arbitrary loops or unbounded parallelism. Dependencies are success-gated by default; failure/always conditions must not bypass cancellation.

### 2.1 Candidate DSL — PROPOSED, not approved schema

~~~yaml
version: 1
id: inspect-repository
name: Inspect repository workflows
inputs:
  repo: { type: string, required: true }
triggers:
  - { id: manual, type: manual }
steps:
  - id: inspect
    uses: mcp.call
    with:
      endpoint: "https://example.org/mcp"
      tool: workflows_list
      arguments:
        repo: { ref: inputs.repo }
    retry: { max_attempts: 1 }
  - id: report
    needs: [inspect]
    if: { eq: [{ ref: steps.inspect.status }, succeeded] }
    uses: result.emit
    with:
      data: { ref: steps.inspect.output }
outputs:
  result: { ref: steps.report.output }
~~~

`endpoint` above is an arbitrary safe HTTP MCP endpoint, **not** a static Connection registry key. `result.emit` is illustrative, not a newly approved capability implementation. For runtime-computed endpoints, the evaluated concrete target/tool/scope must have the owner's valid Operation Authorization before actual invocation.

**PROPOSED:** restrict `uses` to `mcp.call`, an internal result operation, and named registered heavy capabilities (e.g., `heavy.browser.snapshot`). **No generic `shell.run`**, arbitrary code blobs, hidden script eval, importable function packages or unrestricted external HTTP plugin engine in v0.1. Exact capability inventory must be justified by actual first-slice tests rather than copied from n8n.

### 2.2 Compile/publish algorithm — PROPOSED

1. Read Draft using expected revision; parse strict YAML/JSON with duplicate-key detection.
2. Validate structural schema, stable IDs, references and input/output type compatibility; fail on unknown top-level executable fields.
3. Build DAG; detect cycles, unreachable/unknown dependencies, unsupported `uses`, excessive depth, total Step and ready-Step upper bounds.
4. Compile a restricted expression AST. No user executable runtime code and no implicit conversion granting new capabilities.
5. Discover relevant MCP tools on demand over supported Streamable HTTP protocol versions. Capture required `target_identity`, `tool_name`, compatible schema metadata/fingerprint and permitted `operation_scope`; **do not** require target preregistration. A computed target not known at Publish is represented as a runtime authorization gate, not silently approved.
6. Validate explicit external-operation authorization. If absent, return required approvals and leave the existing Published Version effective; do not install a half-published plan.
7. Canonicalize plan fields and calculate stable digest. Insert immutable Published Version and atomically switch the Workflow active-version pointer, conditional on original Draft revision and approval checks.
8. Return published version identity/digest; no independent mandatory Enable action. Pause/resume affects future admission only. Existing Runs never change plans.

**BLOCKER:** Prove compilation against Cloudflare's durable step replay and parallelism behavior; mere DAG topological sorting is insufficient for side-effect correctness.

### 2.3 Contract error and drift

**DECIDED (Q20, Q28, Q37, Q46):** compare effective target/tool/schema/scope before invocation; on incompatible schema, do **not** automatically have AI rewrite the active plan. Stop with a contract error or wait for new approval if the computed target/tool/scope is unknown. Compatible schema evolution is permitted only if it does not widen Operation Authorization.

**PROPOSED:** classify errors `TOOL_SCHEMA_INCOMPATIBLE`, `AUTHORIZATION_REQUIRED`, `TARGET_UNREACHABLE`, `TRANSPORT_UNSUPPORTED`; keep user-safe details, never raw tokens or sensitive upstream bodies.

## 3. MCP owner-facing API — atomic minimal closure

**DECIDED (Q36, Q43, Q50):** separate atomic operations, always-asynchronous manual run start, no generic `workflow_manage(action=...)` or arbitrary Attempt/D1/GitHub job tools.

**PROPOSED** names and minimal arguments; all methods require owner Portal auth unless trigger-specific authentication is explicitly stated:

| Tool | Input (essential) | Output / behavior |
| --- | --- | --- |
| `workflow_list` | cursor?, limit? | paginated metadata, state, published_version |
| `workflow_get` | workflow_id | current Draft and active version metadata |
| `workflow_create` | definition | Draft ID, revision; no activation |
| `workflow_update` | workflow_id, expected_revision, definition | new Draft revision or `REVISION_CONFLICT` |
| `workflow_validate` | workflow_id, revision | issues and required external grants; no side effects |
| `workflow_publish` | workflow_id, expected_revision, approvals | immutable version/digest; atomic validation+authorization+activation |
| `workflow_pause` | workflow_id | prevents new triggers, leaves active Runs alone |
| `workflow_resume` | workflow_id | restores new trigger admission under unchanged grants |
| `workflow_archive` | workflow_id | retires from admission; keeps required history |
| `workflow_run` | workflow_id, inputs, idempotency_key? | promptly returns `run_id`, `published_version_id`, admission status |
| `workflow_status` | run_id | run + step summary, stable state, pending approval if any |
| `workflow_result` | run_id | safe small output and authorized Artifact references |
| `workflow_logs` | run_id, cursor?, limit? | paginated redacted lifecycle events |
| `workflow_cancel` | run_id | accepted cancellation request, not proof of stop |

**PROPOSED narrowly necessary additions (defer if embedded owner approval UX suffices):** `workflow_approval_list` and `workflow_approval_resolve` for Q37 waiting Runs; `workflow_credential_set` and `workflow_credential_revoke` for Q15/Q30 secrets. Their need is inherent in the accepted lifecycle; precise names and grouping are **not a Q50 mandate**. Avoid exposing raw decrypted credential values or internal attempts.

Example Run start response (**PROPOSED**):

~~~json
{
  "run_id": "run_opaque",
  "workflow_id": "inspect-repository",
  "published_version_id": "v_opaque",
  "status": "queued",
  "idempotent_replay": false
}
~~~

**PROPOSED:** stable error envelope `{code,message,details?,retryable,correlation_id}` with no secrets, raw upstream credential-bearing error body, or concealed permission expansion. Paging for logs/list uses opaque cursors.

## 4. Run, Step, Attempt and admission semantics

**DECIDED (Q25, Q29, Q33, Q37, Q41, Q43–Q44, Q47):** states must distinguish successful/failed/cancelled/indeterminate, and an Authorization Wait is a **Run** that cannot continue a specific unauthorized operation; it is *not* Paused Workflow.

### 4.1 Candidate state table — PROPOSED

| Aggregate | Nonterminal | Terminal/other | Rules |
| --- | --- | --- | --- |
| Workflow | draft, active, paused | archived | paused/archived refuse *new* admissions; neither cancels existing Runs |
| Run | queued, running, waiting_authorization, waiting_external, cancel_requested | succeeded, failed, cancelled, indeterminate | do not mark cancelled until confirmed external termination/stop where relevant |
| Step | pending, ready, running, waiting_authorization, waiting_external | succeeded, skipped, failed, cancelled, indeterminate | dependency success is default; explicit handling modes remain behind cancellation gate |
| Attempt | created, dispatched_unknown, claimed, executing, result_pending | succeeded, failed, cancelled, indeterminate | Claim does not establish side-effect completion |

Status names are **candidate values**, not owner-approved enum strings. A Run may have `cancel_requested` and an indeterminate Step; the final aggregation must not disguise unverified external effects as a clean cancellation. Result snapshots should separately expose `execution_outcome` and `cancellation_request_status` where needed.

### 4.2 Admission, capacity and platform queuing

**DECIDED Q47=A:** when the *application's* active/queued Run budget has been exhausted, the trigger admission fails with a distinct capacity error. No custom persistent overflow queue is built. **VERIFY:** Cloudflare Workflows has its *own* queue for instances over platform concurrency limits; the app limit must be enforced before calling `create()` and must not claim to disable Cloudflare's internal queue.

**PROPOSED:** D1 admission CAS or conditional insert reserves capacity and records the idempotency key, `run_id`, deterministic Workflow instance ID and `start_state`. D1 commit and Workflow `create()` are separate transactions. Use H2's reserved/started/start_unknown reconciliation; repeat only with the SAME instance ID, query `get(id)` before declaring success, never silently queue capacity-rejected runs, and never assume a missing expired platform instance authorizes repeating external effects.

### 4.3 Step decision table — PROPOSED for final spec review

| Dependency / event | Default outcome | Explicit alternative |
| --- | --- | --- |
| All dependencies succeeded | evaluate `if`, then run or skip | none needed |
| Dependency failed | skip dependent Step | authorized failure handler |
| Dependency skipped | skip unless predicate explicitly supports skip | explicit condition |
| Dependency indeterminate | do not proceed with externally effectful dependent work | explicit owner reconciliation, not auto-retry |
| Run cancelling | no new ordinary operations | authorized stop/receipt logic only |
| Unknown target/tool/scope | authorization wait before call | approve concrete operation or refuse |
| External effect possibly performed, response lost | indeterminate pending reconciliation | prove outcome; never blind replay |

These are suggested detailed rows consistent with Q25/Q33/Q37/Q41/Q44; error enum, approval timeout and precise terminal aggregation still need technical sign-off.

## 5. Triggers and scheduled execution

**DECIDED (Q9, Q23–Q24, Q31–Q32):** Manual, authenticated Webhook with namespace `workflow_id + trigger_id + source + event_id` and finite dedup retention, and timezone-aware Cron with default `misfire: latest`; nonexistent DST local times skipped, repeated wall-clock time admitted once.

**PROPOSED:** manual calls use authenticated `workflow_run`; Webhook ingress uses per-trigger signed secret/HMAC or equivalent trusted upstream proof (do not use shared Portal token as the Webhook secret); reject unsigned or invalid requests before admission, and enforce replay window/size limits. Duplicate known event returns original Run ID.

**Important runtime-schedule issue (VERIFY/P0):** Cloudflare Worker Cron triggers are provisioned as deployed schedules, while Q5=B requires runtime-created Workflow Cron definitions. A *single* fixed Worker tick may query due definitions in D1 and admit due Runs with occurrence-based CAS keys; it must not become a second DAG progression engine or a per-definition dynamically deployed Worker Cron. Establish accurate timezone/DST/misfire semantics and plan-limit cost before selecting ticker frequency. This mechanism is a **proposal**, not user-confirmed architecture.

## 6. Dynamic MCP connection, authorization and credentials

**DECIDED (Q7, Q14–Q17, Q20–Q22, Q28, Q30, Q37, Q46):** any supported safely reachable Streamable HTTP MCP Server may be discovered without preregistration; tested current/recent protocol revisions; credentials stored target-specifically encrypted in D1 with separate Worker Secret; no Portal token forwarding; network SSRF defenses; owner grants apply to concrete target+tool+operation scope, with renewed approval for widened/high-risk drift.

**PROPOSED invocation pipeline:**

1. Evaluate endpoint/tool/arguments from pinned plan and Run input through restricted expressions.
2. Check URL/redirect/network class and origin binding before connecting; on a computed new target, check specific grant. Missing grant means Authorization Wait before any external *business tool invocation*. Limited, protected capability discovery and authentication negotiation may still be required to identify a target/tool for approval; discovery must not itself trigger a privileged operation.
3. Resolve target-specific credential by opaque reference; decrypt only at invocation; do not persist plaintext in logs/Run payloads or pass it to another target.
4. Negotiate a tested Streamable HTTP revision; perform tool discovery/schema contract comparison. Incompatible schema means stop with contract error, not AI auto-remapping.
5. Enforce target+tool+operation-scope grant; call only with validated arguments and a bounded response-size/time budget.
6. Persist safe result/Attempt outcome and only retry when independently known read-only or proven idempotent; do not trust remote MCP tool annotations as sole evidence of idempotence.

**BLOCKER:** cloud Worker `fetch` + DNS/redirect behavior must prove SSRF defense for loopback/private/metadata/redirect and rebinding. Hostname-only checks cannot guarantee DNS pinning. If a safe enforcement method is not available on the selected transport, the affected dynamic call path must fail closed rather than weaken Q7 or silently introduce host allowlisting.

**2026-10-20 partial evidence:** [Target-bound credentials and redirected request](p0-mcp-cron-isolated-20261020.md) passed in the **actual gateway source executed locally** against two real Cloudflare targets: per-origin test credentials stayed isolated; a 302 from target A to B was rejected with `redirect:'manual'`, confirmed by D1 counts. The edge gateway's test secret provisioning was blocked, so **this is NOT a full Cloudflare gateway SSRF pass**; real DNS/IP rebinding and metadata/private-network behavior remain unproven. **Default no-redirect + no credential forwarding** is the simplest safe tested policy; adding generalized redirect delegation or a proxy is not justified.

### P0-3 egress option gate — primary-source re-review (2026-10-21)

**Status: SOURCE-LEVEL EVIDENCE; LIVE EDGE SSRF ACCEPTANCE STILL OPEN.** This review refines the implementation options and proof requirements; it does not reopen owner-confirmed Q1–Q50, implement S2, authorize a deployment or relax AC-08.

**Confirmed upstream implementation contract (not independently tested on our Cloudflare deployment):**

- [Cloudflare workerd `Network` schema](https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp) says its default global outbound network uses `allow = ["public"]`; IP restriction occurs **after DNS resolution** by filtering returned addresses, and a hostname whose addresses are all prohibited fails like a nonexistent DNS entry. Explicit private network or custom `globalOutbound` configuration can weaken this guarantee. [Cloudflare's workerd maintainer independently explains this model](https://github.com/cloudflare/workerd/discussions/1523). This gives a stronger basis than merely regex-checking hostnames, but is **not equivalent to a recorded live Cloudflare-edge DNS-rebinding test**.
- [Cloudflare workerd compatibility source](https://github.com/cloudflare/workerd/blob/main/src/workerd/io/compatibility-date.capnp) and [Workers compatibility documentation](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public) describe the **distinct** `global_fetch_strictly_public` flag: it prevents same-zone global `fetch()` from silently bypassing front-door security controls to access an origin. It does **not itself implement DNS private-IP filtering**; that is a separate outbound-network property. [Workers `fetch` documentation](https://developers.cloudflare.com/workers/runtime-apis/fetch/) also confirms the flag's Worker-to-Worker public HTTPS use case.
- [Workers VPC Network `cf1:network`](https://developers.cloudflare.com/workers-vpc/configuration/vpc-networks/) would add access to account-reachable private Tunnel/Mesh/WAN resources as well as Gateway-filtered public egress. Gateway [Traffic Source selectors](https://developers.cloudflare.com/cloudflare-one/traffic-controls/http-policies/) identify ingress types; logs may [record originating Worker IDs](https://developers.cloudflare.com/changelog/post/2026-09-29-mesh-workers-vpc-network-logs/), but **Worker-attributed logs do not prove per-Worker policy targeting**. Avoid VPC/Gateway for the minimum public MCP slice unless proven necessary and safely isolated.

**Option selection (PROPOSED; evidence-driven, minimal):** First validate a standalone S2 dynamic **public-only** MCP operation using ordinary global `fetch()`, with `global_fetch_strictly_public` explicitly enabled for that future S2 runtime, and **no private VPC Network, origin, service-to-private-target, custom outbound, or Gateway binding exposed to dynamic URLs**. Keep the existing S1 `READONLY_TARGET` Service Binding for its fixture only; never forward untrusted dynamic endpoints through it. Only the selected transport makes an outbound request. A single narrow transport boundary should enforce HTTPS, normalized valid host/port, no URL userinfo, no direct IP literals or reserved hostnames, `redirect: "manual"` and refusal to follow 3xx without an explicitly authorized new target. Do not rely on these syntactic checks for post-DNS protection. Retain target + tool + operation-scope grants, target-scoped credentials, schema-drift rejection and no cross-origin credential forwarding. This is a **transport usage constraint**, not a new proxy/service/registry or a static target whitelist.

**2026-10-21 SDK redirect and authorization boundary (P0-3 additional finding):** [Cloudflare Request](https://developers.cloudflare.com/workers/runtime-apis/request/) explicitly warns that Worker-originated `fetch()` requests using `redirect: "follow"` can carry **all** request headers across host/domain redirects, including `Authorization` and `Cookie`. Even where private-IP SSRF is blocked, **public cross-origin credential exfiltration** remains possible. An [upstream TypeScript SDK issue #2700](https://github.com/modelcontextprotocol/typescript-sdk/issues/2700) identifies that the Streamable HTTP client can use the default redirect-following fetch behavior; its reported reproduction is an upstream issue, **not evidence that the pinned 2.0.0 S1 fixture exposed private services**. The [SDK transport](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/client/src/client/streamableHttp.ts) provides a custom `fetch` option; S1 already uses that injection point for the private fixture in `src/runner.ts:callFixture`. Reuse **the SDK and its injection point**, not the fixture binding, for any future S2 public transport.

**One required S2 transport invariant, no new service:** Build a single target-scoped fetch callback with a **previously approved canonical concrete endpoint**, rather than trusting each SDK call's URL. For **every transport method** (including initialization, tool call, GET stream/reconnect, DELETE/close), validate normalized HTTPS origin and allowed path/query semantics for that target before dispatch; force `redirect: "manual"` **after** merging SDK-supplied `Request` and `RequestInit` so they cannot override it; reject any 3xx and never fetch its `Location`. Only add target-specific credentials after the authorization and endpoint check; never inject owner Portal bearer credentials or carry headers to an alternative Origin. SDK auto-OAuth discovery/refresh may make requests outside a custom transport `fetch`; **exclude auto-OAuth from the first S2 read-only slice** until its full metadata/token fetch surface is separately covered and verified. Reject a dynamic target that equals the Workflow MCP ingress endpoint to avoid a same-Worker recursion path under `global_fetch_strictly_public`. These are implementation/test requirements, not newly implemented functionality.

**Next smallest local verification before any authorized edge test:** Use the pinned S1 SDK version and a disposable in-process HTTP transport fixture to assert: (1) ordinary same-origin initialize/list/call completes; (2) a 302/307 to a second public fixture never sends the second request; (3) the second fixture never sees an Authorization/Cookie header; (4) any SDK attempt to override redirect mode is neutralized by the target-scoped callback; (5) a distinct initially-requested Origin is rejected before network use; (6) SDK GET/DELETE/reconnect and nonstandard target paths receive the same policy. No actual private device/server or live secrets should participate. Passing this **only proves application-level request handling**, not Worker edge DNS/private-IP semantics or AC-08.

**Current S1 baseline:** PR #142 at examined implementation `efd7c47` uses `compatibility_date: "2026-09-10"`, `workers_dev: false`, and a fixed `READONLY_TARGET` Service Binding for its echo fixture, **without** `global_fetch_strictly_public`. S1 intentionally has no dynamic public MCP fetch. Therefore neither this review nor the flag should be retroactively described as implemented/tested in S1; adding the flag is only a **future S2 configuration proposal**, not authorization to change S1.

| Proof / control | Evidence so far | Interpretation |
| --- | --- | --- |
| Public HTTPS Worker `fetch()` | Prior isolated Cloudflare public Worker-to-Worker HTTP 200 | Narrow connectivity PASS, not full egress security |
| Own-zone front-door routing | Upstream compatibility source/flag; not pinned to a deployed S2 build | Source-level supported, S2 deployment VERIFY |
| Default private-IP exclusion including DNS results | Upstream workerd `Network` schema with post-resolution address filter | Strong source-level design evidence, live edge NOT VERIFIED |
| Redirect / target credential isolation | Prior local gateway source exercised against two real public targets: cross-origin 302 manually rejected and credentials isolated | Partial local integration PASS; live S2 transport pending |
| Live loopback, RFC1918, link-local, metadata & controlled DNS rebinding probes | No independently attributable Cloudflare-edge results | **AC-08 NOT PASSED** |
| Gateway per-test-Worker rules and unchanged private-device traffic | No read-only account policy inventory or demonstrated per-Worker selector | Not established; do not mutate account rules |
| Worker lifecycle/cleanup of new P0-3 experiment | No new Worker deployed during this review | Nothing to clean for this review; next experiment must prove deletion |

**Access and execution facts:** WSL2 Ubuntu device had a local repository checkout and reusable **cached Wrangler 4.151.0**, which successfully authenticated via existing Cloudflare OAuth despite not being on `PATH`. Separate Cloudflare account connector/documentation/OpenAPI calls and the open dashboard page failed to read. A later proposed temporary egress test was **stopped by the Remote Control execution tool safety check before starting**; there was no run session or deployment receipt. Do not retry that blocked command by splitting or redirecting it through another executor. Those are access/execution limitations, not a real-world network PASS or FAIL.

**Minimal falsifiable follow-up** (only after a permitted and specifically scoped test mechanism exists): reuse a disposable, non-production edge Worker with the public-only flag and no private bindings; prove positive public read-only MCP connectivity; independently verify the code path never follows redirects or passes target A credentials to target B; conduct negative loopback/RFC1918/link-local/metadata and controlled DNS-resolution-change tests **against self-owned harmless fixtures**, measuring actual received requests rather than HTTP error strings alone; verify current Remote Control private route baseline is unaffected; delete test Worker and compare inventory. No actual private business service should be probed or used as a sink.

**Stop conditions:** No source and edge proof that the exact future S2 path uses the intended public-only egress, any unsafe reachability, failed cleanup, insufficient permission to test safely, or uncertain effect on private routes means **S2 dynamic effectful operations remain fail-closed**. Return to the option gate if the native public-only transport cannot meet AC-08. Do not create an outbound proxy, Gateway rule, VPC binding, new persistent resource, or new CI executor merely to work around missing evidence or a blocked tool call.

**PROPOSED encryption envelope:** `{ciphertext,nonce,key_version,aad_target_id}` using authenticated encryption and separated master-key material. Rotation keeps grants when scope unchanged, but revocation immediately denies subsequent invocation; already dispatched external effects cannot be undone. **VERIFY:** design backup restore and key loss/recovery before production data.

## 7. GitHub Actions executor and callback protocol

**DECIDED (Q18, Q26–Q27, Q33–Q35, Q48):** heavy capabilities only from a controlled registered set; independent minimal-scope dispatch credential, separate from existing GitHub Actions MCP PAT pool; GitHub OIDC identity; atomic D1 Attempt Claim; callback fact persisted before notification; best-effort cancellation; version compatibility gate; R2 for large Artifacts.

### 7.1 Candidate dispatch/claim sequence — PROPOSED

1. Cloudflare orchestrator creates logical `attempt_id` with fixed `run_id,step_id,plan_digest,capability_id` and `dispatch_id`.
2. Dispatcher requests registered `workflow_dispatch` to a pinned executor workflow/ref with *non-secret opaque inputs*. Use the GitHub REST API version that returns `workflow_run_id` directly (verified using `X-GitHub-Api-Version: 2026-03-10` in an isolated repo); persist the returned Run ID/URL and do **not** search for it on normal 200 success. On a lost or unusable response, record `dispatch_unknown` and **never blindly redispatch**. A unique opaque correlation value / GitHub run name can identify a *candidate for verification* in the run list, but this alone **does not authorize OIDC Claim**. Remain fail-closed unless specific dispatch-to-Run proof is established using authoritative metadata and the signed physical identity. Neither dispatch acceptance nor a GitHub Run ID proves execution success. See [actual ACK-loss simulation](p0-github-candidate-fencing-isolated-20261020.md).
3. Each physical GitHub job obtains GitHub OIDC and presents it to callback/claim endpoint; verify signature, issuer, audience, repository identity, selected workflow/ref and freshness **and bind its physical run/attempt identity to an already authorized dispatch candidate** (7.4). An unrelated Job in the same trusted repo must not claim an arbitrary known `attempt_id`.
4. One atomic D1 `UPDATE ... WHERE owner IS NULL` or equivalent Claim grants the **one** candidate permission to do business work. A losing candidate exits without calling external business capability.
5. Owner executes pinned capability and produces safe bounded result or R2 Artifact reference. Secrets must not be passed in GitHub dispatch inputs.
6. Authenticated callback is validated and inserted idempotently into D1; only then send the matching event to Cloudflare Workflow.
7. If signaling fails or callback is early/duplicated/late, a bounded reconcile reads the D1 receipt and safely re-notifies/correlates without triggering the original work twice.
8. Cancellation sends a best-effort stop to owned work but reports completed stop only after confirmation; Claim timeout alone never transfers authority to a possibly still-running second owner.

### 7.2 Candidate correlation and SQL invariant

**PROPOSED callback identity:** `(attempt_id, candidate_run_id, callback_id, event_type)`, bound to pinned executor identity and plan. Enforce uniqueness for callback replay and monotonically valid outcome transitions.

**PROPOSED D1 Claim invariant:** Candidate authorization must be verified **before** executing the following atomic ownership update. The SQL uniqueness mechanism alone does not prove that a claimant was dispatched for the logical Attempt.



~~~sql
UPDATE attempts
SET owner_candidate_id = ?1, claim_state = 'claimed'
WHERE attempt_id = ?2 AND owner_candidate_id IS NULL
  AND claim_state IN ('created', 'dispatch_unknown');
-- Exactly one row changed means this candidate owns execution.
~~~

This is **illustrative**. Actual D1 semantics, authorization race handling, immutable receipts, dispatch ambiguity, cancellation and claim timeout must be verified; never add a generic distributed lock service.

### 7.3 Durable callback inbox

**DECIDED Q48:** receipt-first. D1 callback record stores validation status, correlation, idempotency and delivery state. Event notification is an optimization for waking the orchestrator, not the only record of completion. Reconcile boundedly from persisted receipts when the first notification fails; ensure already-completed or cancelled Runs cannot be mutated by late callbacks.

**VERIFY:** Cloudflare Workflows supports `waitForEvent`/ `sendEvent` and early buffering, but platform event receipt alone is not equivalent to durable application receipt. See [events and parameters](https://developers.cloudflare.com/workflows/build/events-and-parameters/).

### 7.4 Precise Portal vs Runner trust boundaries and candidate proof — PROPOSED

**Portal auth is reused, not extended to become a GitHub identity issuer.** The current `packages/portal-auth` package checks a configured Bearer token and optional request Origin and strips the inbound Authorization header; it does not certify GitHub repository, workflow, Job or Run provenance. Do not send `MCP_ACCESS_TOKEN` (or target MCP credentials) to GitHub Actions, even as a `workflow_dispatch` input. Runner callbacks/Claim use the existing GitHub OIDC verification module within Workflow MCP, not owner Portal auth and not a parallel user account system.

**Validate before D1 Claim**, using the hosted GitHub JWKS and short-lived JWT: valid signature, issuer `https://token.actions.githubusercontent.com`, exact intended `aud`, expiry/not-before/issued-at with bounded clock tolerance, repository identity (prefer stable `repository_id` in addition to name if available), intended `ref`, `event_name`, workflow identity, and physical candidate Run/Job identity. GitHub's documented `workflow_ref` identifies the normal workflow; `job_workflow_ref` is used for reusable workflows and **must only be required when the selected executor uses one**. Do not treat an optional claim as universally present. Prefer a pinned workflow revision or comparably strict controlled ref when the threat model requires it.

**Critical authorization distinction:** a valid JWT from a trusted repository only proves *origin*. It is **not** permission to claim any user-supplied `attempt_id`. Before granting execution, atomically establish that the physical candidate corresponds to a specifically authorized dispatch of the pinned `attempt_id` / capability / repository / workflow / ref and to an admissible Candidate identity. On the normal GitHub REST dispatch path, correlate with its returned GitHub Run ID. If dispatch confirmation is lost, reconcile candidate evidence against GitHub's authoritative run/workflow metadata first; if that linkage cannot be proven, **fail closed / `dispatch_unknown` rather than accept any Job from the same repo**. A non-secret dispatch correlation input is not itself an authorization credential.

**Physical identity is not just `run_id`:** retrying a Job can reuse a GitHub workflow Run ID while changing `run_attempt` and/or `check_run_id`. Use the strongest available verifiable physical candidate identifier; do not assume that the existing P0-5 test with two different Run IDs proves same-Run reruns are safely distinguished. Persist only fields necessary for identity and owner safety in the existing Attempt record / minimal justified candidate projection. A timeout does not release an owner to another candidate unless reliable evidence proves the first cannot still execute.

**Privilege budget:** each GitHub Runner is granted only `id-token: write` and other specific job permissions required by its registered capability. An OIDC JWT should never become a general-purpose Workflow MCP API key. The verifier is a *small Worker module*, GitHub JWKS is fetched/cached as required by the library (not duplicated in D1), and the D1 Claim remains the single durable execution-ownership authority. Existing P0-5 evidence supports signature validation / one-Run-per-candidate competing for ownership / receipt recovery **only for its measured cases**; candidate-dispatch correlation and same-Run rerun fencing remain new acceptance proofs, not automatically passed.

Official identity reference: [GitHub Actions OIDC claims](https://docs.github.com/en/actions/reference/security/oidc) (including `workflow_ref`, reusable-workflow-only `job_workflow_ref`, `run_id`, `run_attempt` and `check_run_id`).


## 8. Proposed D1/R2 data model

**DECIDED:** data categories and ownership, not SQL names or normalization choices. **PROPOSED minimal logical tables:**

| Logical table | Primary role / keys | Key invariant |
| --- | --- | --- |
| `workflows` | workflow_id, active_version_id, draft_revision, lifecycle | atomic published pointer and pause/archive flag |
| `workflow_versions` | published_version_id, workflow_id, plan_digest, compiled_plan | immutable, referenced by Runs |
| `runs` | run_id, workflow_id, version_id, instance_id, admission_key, start_state, status | immutable version reference, atomic admission/reservation and start-result reconciliation |
| `step_attempts` | attempt_id, run_id, step_id, dispatch_kind, call_fingerprint, dispatch_state, owner_candidate_id?, outcome | one durable dispatch guard for effectful MCP calls; one claimed executor candidate only for heavy Actions jobs |
| `trigger_receipts` | workflow_id, trigger_id, source, event_id | unique within retention window |
| `operation_grants` | target identity, tool, scope fingerprint, version | deny expired/revoked/widened grants |
| `target_credentials` | credential_id, encrypted_envelope, key_version | no plaintext, target ownership bound |
| `callback_receipts` | callback_id, attempt_id, delivery_state | durable before signal, idempotent on replay |
| `artifacts` | artifact_id, run_id, R2 object key, retention | access-check and active-reference protection |
| `run_events` | run_id, sequence/time, safe event metadata | redacted audit and paginated logs |

**PROPOSED:** Step status is derived from `step_attempts`/safe event projection rather than also inventing an independent Step scheduler table. Add separate Step projection only if query cost or semantics demonstrably require it. All writes involving Claim, trigger dedup and Draft CAS must use conditional atomic SQL/batched transactions; event notification happens **after** receipt commit. See [D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/) and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

**DECIDED Q49:** no cleanup of active Run-dependent plan, callback or Artifact references. Post-terminal history and large objects have bounded retention.

**PROPOSED retention algorithm:** mark terminal timestamp; compute retention deadline by data class; never delete a version or Artifact with nonterminal Run references; mark R2 object pending purge before deleting corresponding metadata; delete idempotently, audit purge, and handle partial R2/D1 failure. Do not infer retention duration from Cloudflare Workflows' platform retention alone.

## 9. Compatibility and rollback

**DECIDED Q35, Q45, Q49:** automated releases must check active Run/plan compatibility and refuse unsafe versions absent explicitly reviewed migration. Immutable pinned plan and referenced Artifacts survive compatible deployment.

**PROPOSED manifest:** `engine_protocol_version`, `plan_format_version`, `executor_protocol_version`, required capability revisions, minimum supported plan format. Deployment checks all **nonterminal** Runs and any waiting external callbacks before promotion; if unsupported, fail the release gate. Avoid an additional CD control plane: extend the existing selected-Worker GitHub Actions release path only after explicit implementation authorization. A release or merge does not itself authorize production migrations or credential changes.

## 10. Failure modes / acceptance matrix (full acceptance not executed; preliminary local P0 results linked above)

| ID | Scenario | Required pass evidence |
| --- | --- | --- |
| AC-01 | Two concurrent Draft updates | exactly one accepted at expected revision; other gets conflict, no lost edits |
| AC-02 | Publish validation/authorization failure | old Published Version remains active; no partial activation |
| AC-03 | Edit after Run admission | Run continues pinned plan/digest; new Runs see new version |
| AC-04 | Cycle, unknown dependency, unsafe expression, over-size graph | Publish validation rejects with stable field errors; no arbitrary JS |
| AC-05 | Independent DAG nodes and failed dependency | bounded parallelism and default success gating; explicit handler executes only as allowed |
| AC-06 | Dynamically discovered unapproved target | Run waits before business tool invocation; approval applies to concrete target/tool/scope only |
| AC-07 | MCP schema expands permissions or becomes incompatible | no implicit permission expansion; incompatible calls stop, AI cannot mutate pinned Run |
| AC-08 | Private IP/metadata/redirect/DNS rebinding probe | all unsafe outbound calls denied without static host preregistration |
| AC-09 | Credential rotated, revoked, or decrypt fails | same-scope rotation needs no republish; revoke blocks new use; secrets never appear in logs |
| AC-10 | Duplicate authenticated Webhook event | one logical Run ID per workflow/trigger/source/event; distinct same-body events not conflated |
| AC-11 | Cron DST gap/overlap and scheduler downtime | nonexistent time skipped, overlapping wall time executes once, latest misfire only |
| AC-12 | Application admission capacity exceeded | explicit capacity failure, no custom queued Run created; internal Cloudflare queue not mistaken for app acceptance |
| AC-13 | Manual start with long wait | prompt Run ID returned, status/log/result query works independently |
| AC-14 | Network drops after external write may have committed | status indeterminate, no blind automatic replay |
| AC-15 | Multiple GitHub jobs from ambiguous dispatch | exactly one verified OIDC candidate obtains D1 Claim; losers do no business work |
| AC-16 | Callback duplicated, late, or notification lost | one durable receipt; failed wake-up reconciles, no stale state overwrite or duplicate business operation |
| AC-17 | Cancel external work with no stop confirmation | truthful cancel-request/indeterminate status; never falsely report rolled back effects |
| AC-18 | Pause then archive Workflow with active Run | no new admissions; old Run keeps pinned plan/results; protected references not GC'd |
| AC-19 | Large screenshot / artifact result | D1 keeps metadata/reference, R2 keeps bytes, authorized retrieval and cleanup verified |
| AC-20 | Incompatible engine/runner update with active Run | deployment gate refuses candidate; compatible release passes without replaying committed effects |
| AC-21 | Retries after crashes and replay | completed durable Steps not reissued; tool/write idempotency honored |
| AC-22 | Unauthorized / forged ingress and OIDC claims | fail closed, zero business side effect, safe errors with no token disclosure |

### Evidence and release gates — PROPOSED

- **G0 specification:** Q1–Q50 traceability complete, no hidden owner-level trade-off, explicit proposed schema/limits and unresolved risk list.
- **G1 compiler:** deterministic IR/digest; schema validation, DAG cycle detection, restricted AST and safe expressions, property/negative tests.
- **G2 control-plane:** D1 publication CAS, Run admission idempotency, dynamic target approval and credential encryption, safe query/redaction.
- **G3 orchestration:** actual Cloudflare Workflows durable step replay, event buffering, waiting, schedule admission and late callback recovery.
- **G4 external executor:** OIDC verification, atomic Claim, dispatch-unknown, callback inbox, cancellation and fencing of duplicate physical jobs.
- **G5 production security and compatibility:** SSRF actual-network probes, protocol interoperability matrix, key rotation/revoke tests, version retention/deploy block, measured quotas.
- **G6 release:** single selected-Worker pipeline and safe smoke runs; only close implementation Issues when real evidence demonstrates their own acceptance conditions, reusing unchanged test evidence.

Do **not** interpret these as already passed. Production write-capable launch must not proceed with P0 BLOCKER failures.

## P0-3 / P0-4 isolated SDK and runtime schedule evidence (2026-10-20)

[Isolated SDK/Cloudflare Cron report](p0-mcp-cron-isolated-20261020.md): official MCP TypeScript SDK v2.3.1 server deployed on a throwaway Cloudflare Worker; both SDK v2.3.1 and legacy SDK v1.32.1 clients completed Streamable HTTP handshake, tool discovery and one read-only call over real HTTPS (also passed in-process). This is not a complete protocol negotiation/auth/session matrix. A separate throwaway Worker with one fixed `* * * * *` Cron binding stored runtime plans in D1. Synthetic cloud tick tests passed for spring-forward skipped local time, fall-back one local occurrence, eight concurrent duplicates and runtime schedule edits. **Actual scheduled() invocations: zero observed at audit; real Cron firing NOT verified.** The proof-of-concept 181-minute backward scan is intentionally not a production scheduling algorithm. Security probes against private targets/redirects/DNS were not executed, so P0-3 SSRF remains OPEN. All temporary Workers/D1/secrets were removed, account inventories restored to 12/4/1.

## P0-5 isolated GitHub OIDC and callback recovery evidence (2026-10-20)

[Actual GitHub Actions / Cloudflare P0-5 report](p0-github-oidc-claim-isolated-20261020.md): two independent real GitHub-hosted Jobs successfully presented OIDC credentials verified against GitHub JWKS, expected issuer/audience/repository/ref/job workflow identity. A wrong-audience JWT returned HTTP 401 for both jobs. D1 atomically assigned **one Attempt Claim owner**; losing Job was denied callback (403). Winning Job's duplicate callback produced exactly **one** durable receipt. After deliberately omitting the Workflow notification, an independent verified recovery test run triggered a real Cloudflare Workflow `sendEvent`/`waitForEvent` path. Cloudflare D1 and Workflow management APIs confirmed one Claim, one simulated effect, one receipt `delivered=1`, one notification and an instance `complete`. **This is real cloud feasibility proof, not external exactly-once guarantee.** Recovery driving via an additional GitHub job was test-only; production recovery remains an internal Cloudflare responsibility. Long-lived Job interruption, ambiguous dispatch, forced cancel and cross-region/upgrade recovery remain **OPEN**. The temporary repo, Worker, Workflow and D1 were deleted, with base inventory restored.

## 11. Explicit open technical risks (not further owner decisions by default)

| ID | Risk / missing fact | Severity | Required closure |
| --- | --- | --- | --- |
| RISK-01 | Dynamic endpoint SSRF with Worker DNS, redirects and non-public targets | **P0 BLOCKER** | demonstrate safe network enforcement against rebinding, redirect and metadata probes; otherwise fail closed |
| RISK-02 | Generic DAG interpreter replay and version-compatibility under Cloudflare Workflows | **P0 BLOCKER** | prove deterministic durable step naming, consistent branching and no duplicate external effects over restart/deploy |
| RISK-03 | Dynamic runtime Cron authoring vs deployed Worker Cron schedule | **P0 design-feasibility** | validate one ticker/D1 due-admission plan and timezone/DST semantics without second DAG scheduler |
| RISK-04 | Encrypted D1 credentials, key loss/rotation and revocation races | **P0 security** | authenticated encryption, no plaintext leakage, targeted grant revocation and backup restore tests |
| RISK-05 | GitHub OIDC Claim races and ambiguous dispatch/callback completion | **P0 correctness** | real candidate identity validation, atomic single-owner Claim, durable inbox/reconcile and no owner transfer on timeout alone |
| RISK-06 | Current/recent Streamable HTTP protocol differences | **P1 compatibility** | test actual supported revisions and SDK client behavior; publish explicit supported matrix |
| RISK-07 | Run, Step, Attempt indeterminate/cancelled/failure aggregation | **P1 semantics** | publish transition truth table and verify with externally uncertain writes/cancels |
| RISK-08 | Runtime limits, webhook receipt TTL, inline byte threshold, R2 retention | **P1 reversible values** | benchmark, pick configuration defaults and document quotas; don't turn every limit into a new ADR |
| RISK-09 | External callbacks before wait and after terminal Run | **P0 correctness** | prove fact-first + safe early delivery + re-notification/dedup behavior |
| RISK-10 | Dynamic MCP auth grant binding across redirects/tool changes/credential rotation | **P0 security** | pin target identity and grant scope across invocation and reject drift or unresolved identity |
| RISK-11 | Registered heavy capability vs arbitrary code execution | **P0 security** | prove only pinned approved capability/ref can run; no shell source injection or inherited multi-PAT privileges |


## 11.1 Adversarial review hardening — proposed execution invariants

**Review date: 2026-10-20.** This section supplements the owner-approved Q1–Q50 decisions; it is **PROPOSED/VERIFY**, not a new owner decision. It resolves implementation gaps that otherwise make the consolidated spec unsafe to implement as written. Existing platform components remain unchanged.

### H1. Non-idempotent MCP tool invocation and Workflow replay — P0 BLOCKER

Cloudflare Workflows applies documented default `step.do()` retries (`retries.limit = 5` with exponential backoff) unless configured otherwise. A durable step result prevents replay of already-*completed* steps; it does **not** establish exactly-once effects for calls that committed remotely and lost their response.

**Proposed minimal rule:** reuse the logical `step_attempts` model for both effectful MCP calls and GitHub heavy jobs; only GitHub physical-job candidates require OIDC/Claim. For every potentially effectful MCP operation:

1. Evaluate the pinned plan and validate target, tool, arguments, scope, active grant and required permission; classify as verified read-only, idempotent with proven end-to-end key/receipt, or effectful with unknown idempotence. Never treat an upstream MCP annotation alone as proof.
2. Before the network call, atomically reserve one **logical dispatch** using `run_id + step_id + attempt_id + call_fingerprint`. Persist `not_sent / possibly_sent / confirmed / indeterminate` (candidate state names). This is a *dispatch guard*, not a second DAG scheduler.
3. Explicitly configure and test step retry behavior. If a callback is replayed after `possibly_sent`, **do not reissue** an effectful call unless the specific target provides a verified idempotency or result-query contract. A crash after recording `possibly_sent` but before sending may conservatively yield `indeterminate`; honest uncertainty is safer than duplicate side effects.
4. A definite remote receipt can transition to `confirmed`; a timeout/reset after a possibly issued request transitions to `indeterminate` with a safe reconciliation explanation. Normal read-only work may use bounded Workflows retries.
5. Cancellation does not restore the ability to retry an uncertain write and does not retroactively undo the effect. Keep Run, Step and Attempt outcomes distinct.

**Proof:** inject transport loss immediately before and after remote commit, Worker termination between dispatch reservation and send, and a Workflows replay with default retries. Assert no second non-idempotent outbound invocation for the *same logical Attempt*, truthful `indeterminate`, and no target-level exactly-once claim without the target's own transaction/idempotency evidence. Verify in the pinned SDK that configured retry suppression plus the persisted dispatch guard actually survives restart.

### H2. D1 admission versus Workflow instance creation — P0 BLOCKER

D1 commit and `WORKFLOW.create()` are **not one atomic transaction**. The existing deterministic ID idea must be specified as an explicit recovery protocol:

1. Atomically reserve one quota slot and record a unique `run_id`, immutable `published_version_id`, admission idempotency key, a deterministic globally unique Workflow `instance_id`, and `start_state=reserved` in D1. Same admission key resolves to the same logical Run.
2. Call the bound Workflow's `create({id: instance_id, params: {run_id, published_version_id}})`. On confirmed success, conditionally set `started`. A response timeout is `start_unknown`, **not** `started` and not definitive failure.
3. Reconcile by `get(instance_id)` / `status()`. If the existing ID is found, finalize `started`. If lookup is inconclusive, retry boundedly. Only retry `create` with the **same ID**, and never create a second Run/slot; treat duplicate-ID rejection as a reason to query the existing instance, not as success evidence.
4. Release the reserved slot exactly once only after a definitive failure/no-instance outcome and no outstanding creation ambiguity; otherwise preserve `start_unknown` for ingress reconciliation.
5. Reconcile unresolved starts using a bounded ingress repair pass (for example, in the same fixed trigger tick), not a separate DAG scheduler or unlimited retry queue.

**Edge:** Cloudflare instance ID uniqueness is bounded by instance retention. After platform retention, D1 must remain the admission idempotency authority for its own selected window and must not allow replay of an old side-effecting Run solely because `get()` no longer finds the instance. Actual create/lookup visibility, retention expiry and duplicate errors are **VERIFY** items.

### H3. Dynamic safe MCP HTTP invocation — P0 BLOCKER

Keep **Q7=B**: no static mandatory preregistration of MCP Server URLs. A public URL is not inherently safe to fetch.

- Exercise the actual deployed Cloudflare Worker path for public HTTPS MCP, same-account and cross-Worker public endpoints. Cloudflare documents Worker-to-Worker access through Service Bindings or `global_fetch_strictly_public`. Bindings to known services can be an optimization, **not a required registry** for arbitrary supported targets.
- Verify allowed scheme and redirect policy, all-hop target checks, DNS rebinding/private/loopback/metadata defenses, TLS/origin, scoped credentials and rejection of forwarding credentials across origin. Disable unreviewed redirect following. A hostname string check does **not** establish DNS pinning.
- Use/test the current MCP client SDK rather than writing a new transport stack. Current 2025 and 2026 Streamable HTTP protocol eras have different `initialize` vs `server/discover` paths and behavior. Produce an *actual tested compatibility matrix* covering client/server handshake, transport sessions, tool discovery, errors and auth.
- Preauthorization discovery can contact an otherwise safe MCP endpoint **only for protected discovery/negotiation**; it must never execute an unapproved external business tool. When target/tool/scope is new, transition the Run to Authorization Wait.
- If the chosen Worker networking stack cannot enforce a required SSRF safety property, **fail closed for that dynamic target path**. Neither secretly weaken safety nor silently convert Q7 into a static whitelist.

**Proof:** deployed public Worker-to-Worker and external MCP calls succeed; localhost, metadata, private targets, redirect-to-private and rebinding attempts are rejected; no credential crosses into a different target origin; tested 2025/2026 protocol endpoints negotiate correctly or fail safely.

### H4. Runtime Cron without a second scheduler — P0 feasibility / P1 cost

Runtime-created Cron definitions must not require a Worker redeploy per Workflow. Use **one deployed scheduled ingress** (Worker Cron or an equivalent fixed tick). On each tick, read D1 active schedule definitions, calculate intended occurrences in declared zones, atomically deduplicate/admit Runs and apply `misfire: latest`, skipped nonexistent DST time and single execution of duplicated wall time. Do **not** progress DAG Steps in that tick.

The ticker's interval is a **proposed, configurable** value derived from required schedule granularity, Cloudflare quota and D1 scan cost. Do not promise precision finer than the tick/processing limits, and do not assume per-definition Cloudflare Workflow `schedules` are dynamically writable without redeployment. Measure cost on the intended plan.

### H5. Heavy runner, callbacks and capacity: simplify the normal path

- **GitHub dispatch:** for the actual REST API version, request returned Run details where supported. On success persist returned `workflow_run_id`/URL; do not waste cycles searching for an ID you already have. Dispatch response loss or absent usable ID remains `dispatch_unknown` and enters bounded reconciliation. Dispatch acceptance never proves business completion.
- **Single Claim and receipt:** only an authenticated, correctly scoped OIDC physical candidate may win the existing atomic D1 Attempt Claim. One durable callback receipt is inserted **before** Workflow notification. A failed notification requires bounded replay/reconciliation of that receipt, not a new broker or another scheduler.
- **Capacity:** when app-level Run capacity is full, return a clear retryable error (suggest HTTP 429/503 and `Retry-After` where appropriate) *without acknowledging event acceptance*. Under Q47=A no durable overflow queue exists; sources that never retry may lose those events. Do not promise lossless at-least-once ingress in that case. Cloudflare's internal instance queue is separate from the application's admission policy.

### H6. Result limits and release compatibility

Cloudflare currently documents a **1 MiB non-stream `step.do()` output limit** and bounded instance storage. An application-defined inline output threshold must be **below platform limits**; large files, screenshots and outputs move to R2 and return an authorized reference (Q34). No blanket upload of all JSON to R2. Retain active Run plans and essential evidence until the nonterminal Run completes (Q49), even across compatible deployments and instance-retention expiry. Blocking unsafe upgrades (Q35) must be demonstrated without inventing a general migration framework.

### H7. Three implementation slices — PROPOSED sequence, not implementation permission

| Slice | Include | Exit evidence | Not yet permitted from earlier slice |
| --- | --- | --- | --- |
| S1 — safe orchestration | Draft/Publish compiled plan, bounded DAG, manual async Run, one read-only MCP target, D1 queries, deterministic instance start | compiler replay and revision conflict, idempotent Run admission, crash-after-D1 create recovery, read-only execution | production writes, GitHub heavy side effects |
| S2 — reliable MCP automation | authenticated Webhook, one dynamic Cron tick, target-specific encrypted credentials and approval wait, dynamic protocol interoperability, safe writes and uncertain outcomes | deployed SSRF probes, 2025/2026 interoperability, duplicate events, DST/misfire, write-after-commit lost response, revocation | arbitrary GitHub heavy execution |
| S3 — heavy execution & production closure | registered GitHub heavy executor, separate dispatch credentials, OIDC Claim, callback inbox, R2, cancellation, release gates | duplicate physical jobs, callback losses, true cancellation, Artifact permission/retention, incompatible deploy rejected | generalized plugin marketplace, n8n UI, new queue/scheduler/vault |

Q1–Q50 still define the **full v0.1 design scope**. Passing S1 does not certify production write operations or full v0.1 readiness. All three slices require explicit future implementation authorization; this PR changes documentation only.

### H8. Additional mandatory acceptance tests (proposed; some preliminary local observations, no full cloud acceptance)

| ID | Adversarial failure | Required observable result |
| --- | --- | --- |
| AC-23 | Default Workflows step retry after committed but unanswered MCP write | no duplicate non-idempotent dispatch; truthful indeterminate/reconcilable result |
| AC-24 | Worker crashes before/after dispatch guard and after remote commit | durable Attempt guard prevents silent duplicate outbound side effect |
| AC-25 | D1 reservation succeeds but Workflow `create()` response is lost | one Run, one reserved slot, same instance ID lookup, no duplicate start |
| AC-26 | Workflow instance past platform retention | D1 prevents unapproved replay or idempotency-key reuse within chosen retention window |
| AC-27 | Actual Cloudflare Worker-to-Worker and 2025/2026 MCP endpoints | supported calls work; unsupported revisions and unsafe targets fail closed |
| AC-28 | Webhook source does not retry when application capacity full | explicit rejection, documented delivery limitation, no false accepted receipt |
| AC-29 | Runtime-created Cron with simultaneous ticks / DST / outage | unique intended occurrence, correct latest misfire and no per-definition deploy |
| AC-30 | GitHub API returns Run ID, versus response lost | direct success path records ID; unknown path reconciles; Claim prevents duplicate business work |

**Mandatory release condition:** S1–S3 exit evidence is reused when unchanged. P0 failures block the related execution capability; no blanket production-success claim is allowed. Future implementation may optimize the mechanisms while preserving every confirmed Q1–Q50 invariant and the proofs above.

**Additional P0-5 proof to reuse only once:** send a correctly signed JWT from the same trusted repository but a **different, not-authorized** workflow Run and assert Claim denial; retry a GitHub Job under the same `run_id` with a different `run_attempt` / candidate identity and assert no second owner or external effect. These two missing cases are not covered by the earlier isolated P0-5 PASS. If a proposed candidate-correlation field/table is needed, justify its lifecycle under `1.3` rather than creating a new registry automatically.

## P0-5 candidate fencing after minimum-entity review (2026-10-20)

[Isolated GitHub OIDC candidate-fencing evidence](p0-github-candidate-fencing-isolated-20261020.md) closes **two tested P0-5 negative scenarios**, not the whole P0 gate: a genuine signed GitHub Job from the same trusted repository/workflow with a *different, unauthorized* GitHub Run ID was rejected with HTTP **403**; rerunning the correctly authorized GitHub Run with unchanged `run_id` but `run_attempt=2` was also rejected with HTTP **403**. The initially authorized candidate (`run_attempt=1`) obtained one D1 owner claim and produced one simulated D1 effect. Cloudflare management D1 queries independently confirmed the exact sequence and one effect. This supports the existing Attempt candidate fields and **requires no new identity/Claim entity**. Test harness paused before Claim to register the known Run ID; **dispatch ambiguity still needs a real fail-closed correlation proof**, and the test did not model arbitrary external effects or cancellation. Temporary repository, Worker and D1 were deleted, with inventory restored.

## 11.2 Phase-specific release gates and fail-closed scope (owner-authorized spec synthesis, 2026-10-20)

**Decision:** stop broad exploratory PoCs. Synthesise the already-approved Q1–Q50 and isolated evidence into **one agent-ready S1 specification** on the existing GitHub issue tracker, then only create implementation tickets after separate phase planning. This is documentation/issue publication authorization, **not** permission to implement, merge or deploy. **One external seam is preferred:** owner-facing MCP operations observed together with real D1 + Cloudflare Workflows Run state; upstream side effects are represented by a deterministic *read-only integration fixture* for S1.

| Delivery stage | Allowed scope | Must pass before enabling outside isolated tests | Failure behavior / deferred scope |
| --- | --- | --- | --- |
| **S1 — implementation-ready core, controlled tests only** | Portal-authenticated create/edit/validate/explicit Publish; immutable Published Plan; bounded DAG with restricted expressions, manual async Run, result/status, D1 revision CAS, deterministic Workflow IDs and admission/idempotency; protected read-only test target only | Real Cloudflare state transitions, revision conflicts, replay and create-ACK uncertainty test, fixed Run/version binding, redacted results; verify no write-side-effect replay and no credential forwarding | Fail closed on unknown endpoint / unauthorized operation; no arbitrary public dynamic MCP invocation, unattended target credentials, write-capable tools, Cron, webhook or GitHub heavy executor in S1 |
| **S2 — gated external MCP + triggers** | Runtime arbitrary safe public Streamable HTTP MCP targets without mandatory registration, concrete target/tool/scope grants, encrypted target credentials, bounded external writes; webhook / single fixed Cron tick only as separately validated | **P0-3** Cloudflare-edge DNS/private/metadata/redirect/rebinding controls and credential isolation (fail closed, no silent network downgrade); key rotation/revoke; **P0-4** actual native `scheduled()` → D1 unique Schedule Occurrence → Workflow Run; webhook signature/replay validation | Dynamic-target call stays unavailable until SSRF/key/authorization test is complete; Cron remains disabled until real native trigger test passes. Manual S1 need not wait for Cron. No second DAG scheduler, general network proxy or custom queue |
| **S3 — gated GitHub heavy execution** | Pinned registered capabilities, minimally scoped dispatch, OIDC verified physical candidate, D1 Attempt Claim, receipt-first callback, recoverable workflow wakeup, safe cancellation and Artifacts | **P0-5** linkage from authorized dispatch to actual Run ID/Run Attempt; duplicates, signed but unrelated Job, rerun fence, unknown dispatch, callback duplication/loss and cancellation truthfulness; compatible live-Run release test | Normal GitHub 2026 API 200 returns Run ID directly. On unknown response, preserve `dispatch_unknown`, do not redispatch or authorize a Run by public name/opaque marker. Unproven or unlinked candidates cannot Claim; do not share broad management multi-PAT authority |

**Not an unapproved policy change:** Q7's eventual *non-preregistered* dynamic target requirement remains intact. S1's fixed safe **test fixture is a test seam only**, not a production target allowlist. A later capability can be switched on only after its own gate is demonstrated; G0/spec readiness **does not equal release**. All unpassed P0 security/correctness blockers are preserved and feature-scoped, rather than unnecessarily preventing S1 implementation work.

### Current remaining work and ordering — 2026-10-21 (evidence update only)

This is **status and sequence**, not a new Q decision, ticket, merge or deploy approval. Source of truth: [S1 PR #142](https://github.com/lirtual/mcp-workers/pull/142), [Issue #141](https://github.com/lirtual/mcp-workers/issues/141), [S1 release-readiness](../../S1-RELEASE-READINESS.md), and [existing P0-3/4 cloud test record](p0-mcp-cron-isolated-20261020.md).

| Priority and gate | Actually complete | Remaining work / smallest honest next action |
| --- | --- | --- |
| **P0 — S2 external-target network safety (P0-3)** | Existing gateway PoC passed 19/19 offline mock cases; Cloudflare Workers VPC/Gateway binding passed Wrangler 4.130.0 dry-run. | **BLOCKED**: account has existing private networking, and Gateway policy matching to one test Worker and account read permissions are not established. Official selectors do not document single Worker name/ID matching (log-only SourceName/SourceID != enforcement); Cloudflare Gateway policy read attempts failed. Do not create an account-wide deny rule. First obtain authorized *read-only* policy/role visibility and prove isolated source matching; otherwise propose separately isolated Zero Trust test account or reconsider the architecture. Only then run test-owned edge DNS/IP/redirect experiments. No metadata/private route probing. |
| **P1 — S2 real MCP capability** | S1 immutable Plan, Workflows/D1, Portal auth, and 45/45 real-edge read-only fixed-fixture E2E PASS. Limited SDK v1/v2 read-only handshake PoC PASS. | After P0-3 proof, scope a minimal S2 spec for public Streamable HTTP target discovery/transport (no preregistration), target+tool+operation-scope grants, schema-drift stop, separate encrypted target credentials with rotate/revoke, no Portal-token forwarding, and bounded effect/retry/consent tests. Do not enable external target invocation or add credential tables before the actual requirement is demonstrated. |
| **P1 only if Cron is selected — P0-4 schedule trigger** | Synthetic DST/duplicate/runtime-update evidence; real Cron configured in an isolated Worker. | Native scheduled() -> unique D1 occurrence -> real Workflow Run **not observed**, including initial propagation window. Prove one real tick plus durable idempotent admission and bounded due selection before enabling Cron; webhook signature/replay guard remains separate. No second scheduler. |
| **P1 when heavy execution is selected — P0-5 GitHub Actions** | Real signed OIDC/JWKS verification, competing D1 Claim, duplicate receipt recovery, unrelated signed Run rejection and same-Run different-attempt fence passed isolated proofs. | Still need true dispatch response ambiguity -> verified physical Run/Attempt linkage, safe unknown-dispatch decision, external cancellation truthfulness, bounded re-drive of pending callbacks, least-privilege dispatch, and Artifacts/retention plus active-Run upgrade compatibility. Implement only after a S3 spec and proof; do not inherit the management MCP's broad multi-PAT authority. |
| **P2 — S1 review and release selection** | 27/27 unit/contract, 45/45 local and 45/45 real-edge MCP assertions; remote D1 recovery suite; independent AI Standards/Spec/fix re-reviews, latest CI PASS. | PR #142 remains Draft and unmerged; formal GitHub submitted reviews 0; no permanent S1 D1/Workflow/private fixture/Portal secret/route/Environment or release workflow support. Do **not** deploy echo-only S1 solely to call it production. If real production value later justifies first release, explicitly authorize merge/release, verify empty D1, least-privilege bindings, existing release automation, and conditional active-Run compatibility; formal review may be requested separately. |

**Sequence:** (1) safely establish whether a test-only network enforcement scope is even possible; (2) prove the P0-3 connection-time invariant without adding an egress proxy; (3) create the minimal S2 implementation spec and extend S1 only for a real read-only MCP target; (4) consider authorization, credentials, Cron and S3 heavy execution **on their own feature gates**, not as prerequisites to unrelated S1 verification. If isolated native Gateway protection is unavailable, **stop and seek an explicit tradeoff decision** rather than silently weakening Q16 or proliferating services.

**Minimal-entity review gate:** before adding a table, key, queue, Worker, long-lived authorization service or projection, show its unique invariant, which existing D1/Workflows/Portal/GitHub feature cannot uphold, its lifecycle/operation costs, and a failing external-behavior test. In particular, no separate scheduler, generic lock service, self-issued Runner token system, second issue tracker, or per-Run credential registry is proposed.

**Handoff:** GitHub issue created by the installed `to-spec` procedure is a work-spec handoff, not a ticket decomposition or an implementation approval. This draft plus Q1–Q50/ADR evidence remains the canonical reference; concise Issue user stories and acceptance gates should link here rather than copy 50 decisions or every PoC log.

## 12. Final design-tree disposition

Q1–Q50 are recorded as **settled architecture decisions**. The conceptual architecture tree has no known unresolved *product/architecture preference branch*. This does **not** mean there are no remaining engineering unknowns. The remaining values, schemas, test matrices and platform-feasibility questions above are explicitly **PROPOSED/VERIFY/BLOCKER**, not silently approved.

**S1 `to-spec` handoff completed (2026-10-20):** [GitHub Issue #141](https://github.com/lirtual/mcp-workers/issues/141) is the **single** agent-ready S1 implementation specification, labelled `ready-for-agent`. It includes 27 user stories and one owner-facing MCP test seam; it links back to this Draft PR for Q1–Q50 and proof boundaries. **No `to-tickets`, code implementation, merge, production deployment, or credential operations are authorized by the publishing action.** Stage gates in §11.2 remain binding; `ready-for-agent` means the **S1 spec** is actionable, not that P0-3/P0-4/P0-5 or any production release is approved.
