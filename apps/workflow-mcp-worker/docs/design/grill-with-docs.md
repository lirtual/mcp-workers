# Workflow MCP — Grill With Docs design record

Status: **Rounds 1–7 accepted; design tree converged; consolidated spec under review**  
Owner confirmation: **2026-10-20**  
Repository target: `lirtual/mcp-workers`  
Authority: **design documentation only** — no implementation, merge, deployment, credential changes, or Tickets.

## Settled decisions

| ID | Decision | Result | Rationale |
| --- | --- | --- | --- |
| Q1 | Product position | **A — MCP-native orchestration** | Compose existing MCP capabilities and external operations, not another full n8n/Zapier platform. |
| Q2 | Primary interface | **A — AI/MCP-first** | ChatGPT/MCP control is primary; YAML/JSON is declarative source, graphical editor is not required. |
| Q3 | Repository/deployment boundary | **A — independent Worker in current monorepo** | Reuse existing repository tooling while keeping upstream business capabilities separately owned. |
| Q4 | Relationship to prior specification | **A — review and reduce v0.1** | Preserve validated decisions, challenge over-design, and document any supersession; do not restart from scratch. |
| Q5 | Definition authoring and publishing | **B — runtime create/edit/publish via MCP** | Workflow definitions are managed in runtime storage, not exclusively committed to Git and deployed. |
| Q6 | Workflow graph | **A — bounded DAG** | Dependencies, conditions and independent parallel steps; no arbitrary loops or complex dynamic subgraphs in v0.1. |
| Q7 | MCP server discovery / invocation | **B — arbitrary dynamic MCP Servers without preregistration** | No static Connection registry/allowlist prerequisite for calling newly encountered MCP Servers. |
| Q8 | Durable orchestrator | **A — Cloudflare Workflows with D1 coordination/query facts** | Reuse Cloudflare Workflows for progression and waiting, not GitHub Actions-only orchestration or a D1/Queues scheduler. Heavy-task executor unchosen. |
| Q9 | Trigger types | **A — manual + webhook + Cron** | All three supported initially; precise admission semantics remain open. |
| Q10 | Ownership model | **A — single owner using existing Portal auth** | Avoid multi-tenant workspaces/RBAC; external operation permissions still need explicit design. |
| Q11 | Definition publication lifecycle | **A — Draft, validate, explicit Publish** | Saving a definition does not immediately activate it; auto triggers use published definitions. |
| Q12 | Run definition identity | **A — version pinned on start** | Subsequent publication must not alter an in-flight Run's definition. |
| Q13 | Definition/metadata storage | **A — D1** | Use existing D1 for definitions, published versions and metadata; no second definition store. |
| Q14 | Initial MCP transport | **A — Streamable HTTP first** | Non-preregistered supported HTTP targets; legacy SSE/stdio are later scope, not an implicit static allowlist. |
| Q15 | MCP target credentials | **A — on-demand target-specific grant with secure persistence** | Unattended scheduled workflows can reuse authorized credentials; never forward Portal token automatically. |
| Q16 | Network safety | **A — SSRF protection for dynamic targets** | Reject metadata, loopback, unintended private access and DNS-rebinding/redirect bypasses. |
| Q17 | External operation authority | **A — confirmation at enablement** | Confirm allowed external actions before unattended operation; new high-risk actions require re-approval. |
| Q18 | Heavy executor | **A — GitHub Actions for registered heavy capabilities** | Cloudflare Workflows still orchestrates; heavy tasks are bounded rather than arbitrary injected shell. |
| Q19 | Publish and activation | **A — validate, authorize, then activate in Publish** | Do not require a second mandatory Enable step; pause/disable remains available. |
| Q20 | Dynamic MCP tool drift | **A — reapprove widened/high-risk authority** | New high-risk tools, wider permissions or material contract changes require renewed approval; harmless compatible changes do not. |
| Q21 | Dynamic target credential storage | **A — D1 encrypted values + independent Worker Secret key** | Secure owner-managed target credentials without launching a new Vault or Secrets Store service. |
| Q22 | Streamable HTTP compatibility | **A — validated current and recent protocol versions** | Explicit version negotiation/compatibility, not support for every legacy transport or a latest-only assumption. |
| Q23 | Webhook event identity | **A — trigger-specific auth and stable event ID** | Duplicate delivery resolves to one logical Run; body hash is not a reliable event identity. |
| Q24 | Cron misfire | **A — timezone and `misfire: latest`** | When downtime causes missed schedules, do not automatically replay the entire backlog. |
| Q25 | Retry eligibility | **A — bounded retries only for safe operations** | Read-only or proven idempotent work may retry; uncertain external writes are never blindly replayed. |
| Q26 | Heavy executor ownership | **A — GitHub OIDC + atomic D1 Attempt Claim** | Multiple physical candidates cannot all execute one logical Attempt's business work. |
| Q27 | Heavy executor credentials | **A — distinct minimal-scope credential** | Do not reuse the GitHub Actions MCP multi-PAT management authority. |
| Q28 | Dynamic MCP authorization identity | **A — bind target, tool and allowed operation scope** | Same-named tools on different targets do not share approval; no preregistration of MCP Servers required. |
| Q29 | Pause/disable semantics | **A — prevent new admissions, keep existing Runs** | Pausing the Workflow is not cancelling already running work. |
| Q30 | Credential rotation and revocation | **A — same-scope rotation without republish** | Revoked credentials/grants cannot be used for subsequent calls. |
| Q31 | Webhook dedup namespace and retention | **A — Workflow + Trigger + source + event ID, finite retention** | No global forever-growing event-ID store; exact duration remains open. |
| Q32 | Cron daylight saving | **A — skip nonexistent, dedupe repeated local time** | Avoid accidental double occurrence on fall-back transition. |
| Q33 | External cancellation truth | **A — best effort; stopped only after confirmation** | Uncertain external execution or effects must be reported rather than assumed undone. |
| Q34 | Result storage split | **A — small structured results in D1; large Artifacts in R2** | R2 is only for significant files/screenshots, not all JSON results. |
| Q35 | Active Run compatibility on release | **A — validate before automated deploy, block unsafe versions** | Allow compatible releases; incompatible changes require safe migration or stop. |
| Q36 | MCP management surface | **A — granular atomic tools** | Distinct create/update/validate/publish/pause/run-observation tools rather than one generic action dispatcher. |
| Q37 | Runtime-unknown target authorization | **A — wait for explicit specific-operation approval** | Dynamic discovery remains allowed, but unattended Run execution cannot silently gain new target/tool authority. |
| Q38 | Draft concurrency and Publish atomicity | **A — revision checks + atomic Publish** | Reject conflicting/stale updates and leave previous Published Version active when validation/authorization fails. |
| Q39 | Definition retirement with active Runs | **A — archive, retain pinned versions/history** | No immediate hard deletion of a version still required by nonterminal Runs. |
| Q40 | Expression language | **A — restricted typed expressions** | Field references, comparisons, boolean logic; no arbitrary JavaScript eval or custom code functions. |
| Q41 | DAG dependency and failure default | **A — successful dependencies required by default** | Explicit failure/always conditions may be used but cannot bypass Run cancellation. |
| Q42 | Step and parallelism bounds | **A — finite total Steps + concurrent ready-Step cap** | Validate graph size and enforce runtime concurrency; exact thresholds still unresolved. |
| Q43 | Manual MCP Run start | **A — always asynchronous** | Return Run ID; status, logs and results are separate tools. |
| Q44 | Uncertain external outcome | **A — explicit indeterminate** | Distinct from failed/cancelled, with safe reasons for reconciliation. |
| Q45 | Published executable-plan identity | **A — validate/canonicalize/compile immutable plan at Publish** | A Run references its frozen Published Plan and never reinterprets mutable latest DSL. |
| Q46 | MCP Tool Schema incompatibility | **A — stop invocation on incompatible drift** | No autonomous AI rewrite or unapproved argument remapping of a running plan. |
| Q47 | Run capacity saturation | **A — explicit application admission rejection** | No new application-owned persistent overflow queue; native Cloudflare Workflows queue is separate. |
| Q48 | Durable external callback | **A — persist receipt before signaling orchestrator** | Idempotent/late callback processing and recoverable notification failure. |
| Q49 | Retention protection | **A — pin live references, finite post-terminal retention** | Never GC necessary plans/Artifacts while a nonterminal Run needs them. |
| Q50 | First-release MCP surface | **A — necessary atomic owner-facing tools only** | No arbitrary internal Attempt, D1 or GitHub physical-job management tools. |

## Baseline and limits

The historical Workflow MCP v0.1 technical specification dated 2026-09-18 was found in the owner's document library, not in the reviewed `main` tree. Decisions Q1–Q36 now supersede or refine the historical assumptions explicitly described below. The remaining earlier proposals are not automatically ratified.

The current `main` tree was checked before the original Draft PR: no implementation of `apps/workflow-mcp-worker` existed. Files in this PR are documentation only.

## Explicitly superseded or refined historical assumptions

- **Q5=B + Q11=A** override v0.1's static Git-only definitions: owner creates/edits in runtime and explicitly publishes validated definitions, not immediate save-to-production.
- **Q12=A** requires in-flight Runs to use their starting Published Version. Exact artifact/version retention and engine/runner compatibility remain open.
- **Q13=A** selects D1 as the definition/version metadata store; it does **not** authorize plaintext credential storage.
- **Q7=B + Q14=A** remove static MCP Connection preregistration while scoping initial compatibility to any supported Streamable HTTP endpoint. Neither all transports nor all historical MCP protocol versions were approved.
- **Q15=A** allows secure, target-specific stored credentials for recurring operation; it does **not** approve auto-forwarding Portal tokens or a particular vault implementation.
- **Q16=A** makes network SSRF/DNS/redirect protections mandatory without recreating a static target allowlist.
- **Q17=A** makes activation-time operation authority explicit; it does **not** decide approval identity granularity or grant drift rules.
- **Q18=A** selects GitHub Actions as a heavy-task executor for **registered heavy capabilities only**, not the DAG orchestrator; it does **not** restrict discovery of external MCP Servers under Q7=B.
- **Q6=A, Q8=A, Q9=A, Q10=A** continue to mean bounded DAG/Cloudflare orchestrator/manual+webhook+Cron/single owner. None of these decisions adds a custom scheduler, multi-tenant system, visual editor, or arbitrary script plugin engine.

## Final cross-round consistency and over-engineering audit (Q1–Q50)

| Subject | Final finding | Guardrail / technical proof |
| --- | --- | --- |
| Q5/Q11/Q12/Q19/Q38/Q45 — dynamic publishing, version pinning | **Compatible** | Runtime Draft authoring remains. Compile immutable plan at Publish, atomically activate on authorization, keep old plan for existing Runs. No Git-only definition registry or separate Enable step. |
| Q7/Q16/Q20/Q28/Q37/Q46 — any MCP endpoint vs authorization and schema drift | **Compatible with P0 caveat** | Dynamic discovery does not require pre-registration. Network SSRF guard and concrete target+tool+scope grant enforce execution safety. Unknown target waits; incompatible schema stops. This does not authorize automatic AI contract repair. Validate actual Worker networking before implementing. |
| Q6/Q40/Q41/Q42/Q45 — dynamic DAG interpreter | **Compatible, replay-sensitive** | Restricted typed expression AST, bounded DAG and Publish-time canonical plan. The Cloudflare Workflow step identifiers must be deterministic across retries and code versions; prove in integration tests. |
| Q23/Q25/Q26/Q33/Q44/Q48 — callback and idempotence | **Compatible, distinct layers** | Webhook event identity, logical Attempt Claim, durable callback receipt and truthful external result status are independent safeguards. A persisted callback is not proof that arbitrary effects are reversible or that a Run finished. |
| Q42/Q47 — admission saturation | **Compatible** | Reject at application capacity, but do not falsely claim Cloudflare Workflows has no internal queue; no custom queue controller. |
| Q12/Q29/Q35/Q39/Q49 — archive, pause, releases, retention | **Compatible** | Stop new admission without killing existing Runs; nonterminal Run required version/Artifact cannot be GC'd. Release gate blocks incompatible engine/runner versions; terminated data subject to finite retention. |
| Q13/Q21/Q34/Q49 — D1/R2 and credential storage | **Compatible** | D1 query/coordination and encrypted secrets, R2 large bytes; keep a dedicated Worker encryption key. No external vault, plaintext secrets, or second workflow state engine. |
| Q18/Q27/Q36/Q43/Q50 — owner tools vs runner internals | **Compatible** | Public MCP atomic tools cover lifecycle/run/approval; no `workflow_manage` mega-tool and no broad internal Attempt manipulation. Registered GitHub runner permissions remain separate from GitHub Actions management MCP multi-PAT pool. |
| Hidden infrastructure creep | **Rejected** | Do not invent Redis/BullMQ, Temporal, a separate Vault, another CD platform, generic Saga rollback engine, arbitrary scripting sandbox, full n8n editor or role-based multi-tenancy. |
| Technical feasibility | **Unproven until validated** | SSRF/redirect/DNS, deterministic Workflows replay, dynamic Cron ingress, secrets lifecycle and single-Claim callback protocol are P0 proof obligations, not user-confirmed implementations. |

### Final accepted Round 7 decisions

- **Q45=A:** Publish validates/canonicalizes/compiles and fixes an immutable plan. Existing Runs never read mutable latest definitions.
- **Q46=A:** incompatible MCP Tool Schema stops invocation; no silent AI rewriting of an active plan.
- **Q47=A:** application-level admission explicitly rejects excess Run creation and does not build an overflow queue; Cloudflare platform queuing is distinct.
- **Q48=A:** authenticate/persist external callback facts before notifying Cloudflare Workflow; support deduplication and notification recovery.
- **Q49=A:** retain nonterminal Run dependencies and referenced plans/Artifacts; after termination enforce finite retention and safe cleanup.
- **Q50=A:** smallest sufficient atomic owner-facing MCP API; do not expose internal Attempt/D1/GitHub Job admin tools.

### Historical baseline supersession

- Original Git-only definition publication superseded by **Q5=B**; static MCP preregistration superseded by **Q7=B**.
- Original read/run-only seven-tool surface superseded by **Q36=A** plus required runtime authoring/authorization controls; **Q50=A** prevents unrestricted tool proliferation.
- Original potential D1/R2/executor implementation details are approved only where explicitly confirmed by Q1–Q50. Numeric limits, key versions, timeouts, SQL layout, names and sample payloads in the spec are **proposals**.

## Canonical consolidated technical specification

**Document:** [technical-spec-draft.md](technical-spec-draft.md)

This single draft records (1) decided boundaries, (2) proposed implementation contracts, (3) testable failure matrix and (4) remaining P0/P1 feasibility risks. Proposed items are **not owner-approved**. The draft covers:

1. End-to-end logical architecture and invariant ownership (Cloudflare Workflows vs D1 vs GitHub Actions).
2. Candidate YAML/JSON DSL, typed AST, compile/publish/immutable-plan path and schema drift safety.
3. Candidate atomic MCP tools and asynchronous Run API.
4. Candidate Run/Step/Attempt transition tables, uncertain outcomes and admission semantics.
5. Webhook/Cron identities and runtime Cron scheduling feasibility.
6. Dynamic Streamable HTTP, target+tool+scope grants, encrypted target credentials and SSRF enforcement.
7. GitHub OIDC, one Attempt Claim owner, durable callback inbox, lost-notification recovery and cancellation truth.
8. Candidate D1 logical model, R2 Artifacts, retention and release version gating.
9. 22 acceptance/fault scenarios, staged evidence gates and enumerated platform blockers.

**Important:** A conceptual design tree being empty does not mean all technical assumptions are proved. Approval to implement is **not** granted by the drafting or review of the specification.

## Design tree closure

- **Rounds 1–7 settled:** all Q1–Q50 user choices are accepted and documented; the decision list has no known unanswered branch requiring a further Grill With Docs question.
- **No Round 8 by default.** Reopen only a material architectural contradiction or a genuinely unavoidable owner-level trade-off found during specification review or feasibility research.
- **Next step is one holistic technical-spec review**, not endless questioning about byte limits, field names, retry counts, table names or SDK trivia. Such details remain clearly marked PROPOSED/VERIFY/BLOCKER in the draft.
- **Current authority:** continue only documentation review. No code, migrations, CI/infra change, merge, production deployment, credential operations or Tickets.

### External verification references (not additional decisions)

- Cloudflare Workflow deterministic steps/replay: https://developers.cloudflare.com/workflows/build/rules-of-workflows/
- Cloudflare Workflow waitForEvent/early event buffer: https://developers.cloudflare.com/workflows/build/events-and-parameters/
- Cloudflare platform concurrency and queue limits: https://developers.cloudflare.com/workflows/reference/limits/
- Cloudflare D1 atomic transactions and platform limits: https://developers.cloudflare.com/d1/worker-api/d1-database/
- MCP current/legacy Streamable HTTP version negotiation: https://modelcontextprotocol.io/specification
- GitHub OIDC identity: https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments

## Independent adversarial audit, after Q1–Q50 (2026-10-20)

**Owner authorization:** revise docs only. No new Grill question, implementation, issue/Ticket, migration, merge or deployment. This audit **does not reopen** any accepted Q choice and does not treat its proposed engineering mechanisms as approved.

**Verdict:** keep Cloudflare Worker + Workflows + D1, R2 on demand, and GitHub registered heavy executor. No replacement with a full n8n platform or second scheduler. Do **not** implement the previous draft wholesale without closing hard safety gaps.

### Highest-priority corrections in the one canonical spec

| Finding | Severity | Contract correction | Evidence required |
| --- | --- | --- | --- |
| Cloudflare default `step.do()` retry can replay MCP writes after remote commit | **P0** | D1 single-dispatch Attempt guard for effectful MCP calls; stop on possible-send ambiguity, report indeterminate; no blanket exactly-once promises | AC-23/24 under crash, retry and network-loss injection |
| D1 Run reservation and Workflow instance creation are not atomic | **P0** | deterministic ID, reserved/started/start_unknown, same-ID lookup and bounded reconcile; no duplicate quota slot | AC-25/26 |
| Dynamic MCP endpoints on real Workers have SSRF/cross-Worker/redirect complexities | **P0** | fail closed on unsafe network paths, test Worker-to-Worker fetch and current/legacy MCP client protocols; no required preregistration | AC-08/27 |
| Dynamic Cron definitions vs deployed Worker Cron | **P0 feasibility** | one fixed tick handles D1 due occurrence admission; no parallel DAG scheduler or per-workflow deploy | AC-11/29 |
| GitHub dispatch/Callback protocol overbuilt in normal path | **P1 simplify** | use returned Run ID on normal success; unknown only triggers recovery; one durable callback receipt | AC-16/30 |
| Capacity rejection may lose non-retrying Webhooks | **P1 contract** | explicit nonacceptance and retry guidance; do not claim lossless events without queue | AC-12/28 |
| Inline Step result limits / Artifact lifetime | **P1** | bound non-stream output, R2 only for large bytes, protect nonterminal references | AC-19/20 |
| Full first release is too broad to implement as one batch | **P1 delivery** | S1 safe read-only → S2 reliable MCP automation → S3 GitHub heavy execution and production closure; reuse evidence | stage exits in H7 |

**No new architectural primitive:** the MCP dispatch guard extends the already accepted logical Attempt model, not a new distributed scheduler, Saga engine or generalized inbox. The admission repair pass and fixed Cron tick are ingress coordination, not a competing DAG engine. These distinctions should be checked again at implementation review.

**Reviewed official references (fact-check pointers):**
- Cloudflare Workflows default retries, replay and instance ID lookup: https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/ and https://developers.cloudflare.com/workflows/build/workers-api/
- Cloudflare Workflows schedule bindings and platform limits: https://developers.cloudflare.com/workflows/build/trigger-workflows/ and https://developers.cloudflare.com/workflows/reference/limits/
- Worker-to-Worker `fetch` behavior: https://developers.cloudflare.com/workers/runtime-apis/fetch/
- MCP protocol revision differences: https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28
- GitHub dispatch REST return behavior: https://docs.github.com/en/rest/actions/workflows

**Single detailed source:** [technical-spec-draft.md](technical-spec-draft.md), especially H1–H8 and supplemental AC-23–AC-30. No new ADR is justified by this technical review alone; Q1–Q50 decisions remain captured in ADR-0001–0018.

### Completion boundary

The design tree remains closed as product/architecture preference choices. Feasibility tests remain **not executed**, so the work is a reviewable implementation draft, **not** a production-ready proven design. The next approval should be for the whole revised spec or narrow P0 feasibility probes, not a new series of routine field-name/limit interviews.

## P0 local feasibility evidence — first isolated experiments

The [P0 local PoC evidence](p0-local-poc-evidence.md) records actual WSL2 local Wrangler/Workflows/D1 fault injection: unguarded retries created duplicate mock side effects; a durable D1 guard prevented the second effect; simulated post-create acknowledgement loss reconciled by deterministic instance ID; repeated and concurrent admissions remained one Run. Local restart preserved D1 guard and instance results. The isolated test code was **not committed** to this docs PR; its services have been stopped.

**Evidence level: LOCAL_PASS only**, not cloud, real network-loss, remote MCP interoperability, actual instance-expiry or production P0 acceptance. Q1–Q50 remain unchanged; AC-23–AC-26 still require their full applicable cloud/crash proofs.

## Real Cloudflare isolated P0 feasibility evidence (2026-10-20)

[Cloud P0 report](p0-cloud-poc-evidence.md): six scenario groups passed using new isolated D1 + Workflow + mock Worker. Direct Cloudflare API reads confirmed 2 effect records without a guard vs 1 with a guard; the guarded app outcome was `indeterminate` even though the native Workflow status was `complete`. Eight simultaneous identical admissions resulted in one actual execution. The simulated create-acknowledgement loss was recovered through deterministic ID lookup. This **supports** H1/H2, but true connection drops, abrupt cloud termination, platform retention, deployment compatibility and all other P0s are still unverified; neither AC-23–AC-26 nor production reliability gates are marked fully passed.

## Further isolated Cloudflare fault-window checks (2026-10-20)\n\n[Evidence report](p0-cloud-fault-windows-20261020.md) records a real Cloudflare response-body stream abort after mock D1 effect commit (unguarded: 2 effects/2 calls; D1 guarded: 1 effect/2 calls and indeterminate outcome), a waiting v1 Workflow resumed after v2 deployment while retaining v1 step semantics, and successful strict-public HTTPS Worker-to-Worker connectivity. Cloudflare management APIs independently confirmed D1 and Workflow observations. All dedicated temporary cloud resources were removed; account inventory returned to 12 Workers, 4 D1 and 1 Workflow. **These narrow PASS results do not close P0-1/P0-2/P0-3 as a whole**, and full SSRF, SDK handshake matrix, real client-disconnect, abrupt isolate stop and incompatible release gates remain unverified. Q1–Q50 remain unchanged.\n\n## P0-3 / P0-4 SDK and dynamic schedule partial cloud evidence (2026-10-20)

[Isolated evidence report](p0-mcp-cron-isolated-20261020.md) confirms real official MCP SDK v2.3.1 Server–Client interoperability over Cloudflare HTTPS with both v2.3.1 and legacy v1.32.1 clients for the read-only `ping` tool. Runtime D1 plans used a single fixed Cron configuration and conditional occurrence receipts; deterministic simulated ticks verified DST gap/overlap, concurrency dedup and runtime edit without redeploy. One initial faulty total-count assertion was corrected by inspecting keys per calendar day, not by changing the scheduler. **No real native scheduled handler firing had been observed**, and the mini PoC is not a general/efficient Cron compiler. SSRF, redirect/credential isolation and complete MCP protocol versions are NOT approved. Temporary resources deleted; original 12 Workers/4 D1/1 Workflow inventory restored.

## P0-5 actual isolated GitHub Actions OIDC and durable callback evidence (2026-10-20)

[Evidence report](p0-github-oidc-claim-isolated-20261020.md): isolated **private** GitHub repo ran two actual Actions Jobs for the same Attempt. GitHub JWKS-verified OIDC identity/audience/issuer/repo/ref/workflow checks passed; wrong audiences were rejected; D1 `INSERT OR IGNORE` authorized exactly one owner; losing Job callback was forbidden; duplicated winning callback persisted one receipt. A subsequent independent recovery job triggered one real Cloudflare Workflow waiter from the previously persisted, unsent receipt and the receipt was confirmed delivered by independent Cloudflare API queries. This does **not** close real external side effects, timeout/fencing, ambiguous dispatch or forced cancellation acceptance. Test-only repo and all Cloudflare resources were deleted; **12 Workers / 4 D1 / 1 Workflow** baseline restored. Q1–Q50 unchanged.

## Minimum-entity audit and Portal / GitHub Runner boundary (owner-confirmed, 2026-10-20)

The owner agreed that additional entities or durable mechanisms must be justified against existing capabilities before introduction. This is an **implementation-selection constraint**, not a new Grill decision or a reopening of Q10/Q26/Q27.

| Question | Finding / retained choice | Extra moving parts |
| --- | --- | --- |
| Why not only existing Portal? | `packages/portal-auth` presently verifies an owner Portal bearer token and Origin, not a signed GitHub workload identity. Reusing it for Runner callbacks would mean exposing broad owner authority or inventing scoped delegation. | No Portal extension; continue existing owner ingress |
| Why GitHub OIDC? | GitHub already issues short-lived signed job identity and exposes issuer/audience, repository, workflow/ref and Run identity; verify inside the same Workflow MCP Worker. | Small verification module, **no** identity service, signing secret, token issuer, token table or long-lived Runner token |
| Why D1 Claim? | Identity does not make a physical candidate the unique owner; reuse logical `step_attempts` atomic Claim. | No independent Claim server or lock service |
| Why callback receipt? | Persist validated result once before a best-effort notification; reuse the existing D1 callback receipt and Cloudflare Workflows waiter. | No event bus, extra callback daemon or queue |
| Why not reuse existing GitHub Actions MCP `GH_TOKEN` for everything? | Reuse dispatch code and patterns; Q27 protects against silently inheriting a broad multi-PAT account/repository authority. Evaluate a **narrow, proven delegation** first; otherwise justify one minimally scoped dispatch credential, **not** a second management Worker. | No new credential until a concrete scoped path is selected and approved |
| Why no OIDC for normal MCP steps? | Owner Portal authorization and target/tool/scope grant already apply; only GitHub-hosted heavy execution introduces a new workload origin. | Zero GitHub-specific coupling in S1/S2 ordinary runs |

**Security-correctness gap observed on review:** earlier P0-5 tests had *two different GitHub Run IDs*. Those tests prove one winner for that scenario but **not** that any signed Job in an approved repo can claim an arbitrary Attempt, or that GitHub Job re-runs sharing `run_id` are fenced. Final spec now explicitly requires proof that the physical candidate was actually authorized for the **specific** logical Attempt, with `run_attempt`/verified job identity where relevant. GitHub documents `workflow_ref` for ordinary workflows and `job_workflow_ref` for reusable workflows; don't impose a reusable-workflow-only claim on all Jobs.

**Remaining verification, not new infrastructure:** (a) authorized repo but unrelated physical Run must be rejected; (b) same-Run re-run does not inherit or steal execution authority; (c) dispatch-with-unknown-response authorization must fail closed until correlated. Continue to reuse existing evidence for already proven JWT verification, Claim atomicity, and receipt-first recovery. No new test service, ADR, Ticket, implementation or deployment has been authorized by this review.

See [technical-spec-draft.md](technical-spec-draft.md), sections 1.3 and 7.4, and [ADR-0011](../adr/0011-github-runner-claim-and-least-privilege.md).

## P0-5 post-audit GitHub candidate fencing (2026-10-20)

[Candidate-fencing test evidence](p0-github-candidate-fencing-isolated-20261020.md): three real GitHub physical executions were tested with official OIDC. Authorized Run `39408539052` attempt 1 owned the existing logical Attempt; unrelated Run `39408589882` attempt 1 from the **same repository/workflow** was denied HTTP 403; the authorized Run's rerun (same ID, `run_attempt=2`) was also denied HTTP 403. Exactly one D1 effect remained. No new authentication platform, candidate registry or Claim service is needed for this case. **Remain OPEN:** uncertain GitHub dispatch-ID correlation without harness delay, check-run/job retries within an attempt, external effects and fencing after cancellation. All ephemeral resources removed.

## P0-3 / P0-5 remaining trust-edge evidence (2026-10-20)

Existing evidence reports were **extended in place** (no extra ADR or new entity): [P0-3 credential/redirect tests](p0-mcp-cron-isolated-20261020.md) and [P0-5 dispatch response ambiguity](p0-github-candidate-fencing-isolated-20261020.md).

- **P0-3:** actual gateway source running locally contacted two real Cloudflare test Workers; each got only its own test credential. Cross-origin redirect was rejected, and remote D1 recorded no redirected second fetch. The cloud gateway test-secret operation was blocked by execution safeguards, so **edge SSRF and DNS rebinding remain OPEN**, not a claimed PASS. No private-address network probes were attempted.
- **P0-5:** GitHub 2026-03-10 REST workflow dispatch returned a true `workflow_run_id` on normal success; a separate acknowledged dispatch response was deliberately ignored to simulate ACK loss. GitHub REST run discovery identified a matching candidate but **no Claim authority was granted based on a run name/opaque marker alone**. True network response loss and independently proven dispatch-to-Job linkage remain OPEN.
- **Minimal-entity conclusion:** manual redirects rejection, exact origin-scoped credentials, direct returned GitHub Run ID and fail-closed `dispatch_unknown` require no independent credential proxy, per-Attempt token issuer, dispatch queue or extra persistence table for the tested use cases. Both isolated test environments were torn down; Cloudflare baseline restored, temporary private GitHub repo deleted. Q1–Q50 remain unchanged.

## Working rules

1. Ask the complete current frontier in a round; offer one recommended choice per question.
2. Do not silently treat an earlier recommendation as an approved decision.
3. Once resolved, update terms and ADRs as appropriate; do not author implementation until the owner explicitly confirms shared understanding.
4. Challenge duplicate infrastructure and over-engineering explicitly.
