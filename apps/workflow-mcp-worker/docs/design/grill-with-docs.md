# Workflow MCP — Grill With Docs design record

Status: **Rounds 1–6 accepted; Round 7 in progress**  
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

## Round 6 consistency, overlap and over-engineering review

| Seam | Result | Reason / remaining detail |
| --- | --- | --- |
| Q7=B + Q20=A + Q28=A + Q37=A | **Compatible** | Any safely reachable Streamable HTTP MCP Server may be discovered without preregistration, but an unapproved computed target/tool/scope cannot execute. Run waits for approval; this is not a static endpoint whitelist. Approval and wake-up protocol remain unspecified. |
| Q19=A + Q38=A | **Compatible** | Publishing validates and authorizes once and activates atomically; stale Draft writes fail and unsuccessful Publish leaves prior version active. No separate Enable lifecycle or distributed editor is introduced. |
| Q12=A + Q29=A + Q35=A + Q39=A | **Compatible** | Pause blocks admission; archive prevents new Runs; nonterminal Runs still use retained immutable plans. Deployment compatibility checks remain mandatory. Retention/garbage-collection policy is unresolved. |
| Q6=A + Q18=A + Q40=A + Q41=A + Q42=A | **Compatible** | Bounded DAG with restricted typed conditions, dependency-success default, and enforced limits. This is not an arbitrary `run:` code engine, generic loop engine or code sandbox. |
| Q25=A + Q33=A + Q41=A + Q44=A | **Compatible, correctness-critical** | Explicit failure-handling steps cannot bypass cancellation. Lost write replies and uncertain stop requests remain `indeterminate`, not normal failures to blindly retry. Detailed predicates and terminal-state transitions are still pending. |
| Q36=A + Q43=A | **Compatible** | Dedicated start/status/result/log/cancel and draft-management tools provide predictable asynchronous behavior; don't add synchronous/async dual-mode complexity or one generic `workflow_manage` tool. |
| Q37=A vs Q29=A | **Terminology resolved** | Authorization Wait is a **Run** waiting for permission, while Paused Workflow is a **Workflow** denying new admissions. A paused Workflow does not necessarily cancel a waiting Run. |
| Q38=A vs Q35=A | **Different compatibility checks** | Draft revision CAS prevents concurrent author updates; deployment compatibility protects already-pinned plans. They do not require duplicate transaction coordinators. |
| Redundancy review | **No new platform** | No separate orchestration/queue service, multiuser RBAC, optional generic JS sandbox, static MCP host registry, visual editor, general Saga compensation or dynamic execution marketplace. Two ADRs (0015–0016) cover irreversible DSL and Run-output contracts; Q37–Q39 refine existing ADRs. |

## Technical specification convergence — *confirmed requirements only*

| Contract area | Settled from decisions | Undetermined technical values/protocols (not approved) |
| --- | --- | --- |
| Definitions | Runtime Draft create/update; validated authorized atomic Publish; revision conflict detection; immutable pinned Published Versions; archive retains live references | Exact definition schema and digest, edit version keys, API payloads, deletion/GC intervals |
| DAG | Finite acyclic Steps; explicit dependencies and parallelism; restricted typed conditions; success default; explicit failure/always conditions; cancellation outer gate | Expression grammar/type inference, outputs/reference syntax, skipped/failed/indeterminate dependency truth table, numeric limits |
| MCP capabilities | Dynamic safe Streamable HTTP discovery; target+tool+scope authorization; first unknown operation waits; stored target credentials encrypted in D1 | Stable target/tool identity, wait/approval/resume protocol, real transport version matrix, credential envelope and revocation race |
| Triggers | Manual/Webhook/Cron; stable scoped event IDs; timezone, misfire latest, DST skip/dedupe | Request/header schemas, timezone representation, event TTL, admission CAS, scheduler recovery batch sizes |
| Execution | Cloudflare Workflows authoritative DAG; GitHub OIDC + one atomic Attempt Claim for registered heavy work; safe-only retries | Dispatch-unknown, claim/lease/callback protocol, Step/Attempt state transitions, retry budgets, external reconciliation |
| Client tools | Granular draft/run tools; manual Run starts always async returning ID; status/result/log retrieval; truthful indeterminate outcomes | Concrete tool inventory, input/output JSON schemas, pagination, status enums, idempotency and error response schema |
| Storage | D1 definitions/query facts/encrypted secrets/small outputs; R2 large Artifacts; preserve active versions | Byte thresholds, retention windows, encryption key rotation, artifact access/signed URL protocol, cleanup |
| Release | Existing automated release path; block incompatible engine/runner for nonterminal Runs | Plan/protocol version matrix, compatibility probe, rollback and migration proof |

**Convergence rule:** After Round 7, remaining numeric defaults, field names and other reversible implementation details should be proposed together in **one** technical-spec review, not turned into endless design-tree questions. Still escalate unresolved authorization/unsafe execution guarantees or irreversible public semantics rather than silently invent them.

## Reconciled historical v0.1 relationship

- **Superseded**: Git-only definitions/static preregistered MCP Connections (Q5=B/Q7=B); read/run-only seven-tool surface (Q36=A); a model that lacks runtime approval waits, atomic publication or archive of active references (Q37–Q39).
- **Settled through Round 5**: Q1–Q36 establish product scope, runtime authoring, dynamic safely approved MCP calls, Cloudflare+GitHub execution, idempotency/Claim, encrypted D1 credentials, D1/R2 results, trigger/cancellation semantics and atomic management tools.
- **Settled in Round 6**: Q37 Run authorization wait; Q38 optimistic Draft revision/atomic Publish; Q39 archive and immutable version retention; Q40 typed restricted expressions; Q41 dependency-success default/explicit exceptional conditions; Q42 step/parallel bounds; Q43 asynchronous Run admission; Q44 distinct indeterminate outcome.
- **Not yet confirmed**: concrete DSL, public MCP tool schemas, approval/resumption protocol, byte/count/TTL limits, complete Run/Step/Attempt transition table, callback/Claim/lease schemas, deployment protocol version/retention gates and acceptance fault matrix.
- **Design authority**: Decisions are design documentation only; no runtime implementation, merge, deploy, credential action or Tickets.

## Design tree

- **R1 — settled (Q1–Q4)**: product/interface/context/baseline.
- **R2 — settled (Q5–Q10)**: runtime authoring/DAG/dynamic MCP/orchestration/triggers/ownership.
- **R3 — settled (Q11–Q18)**: drafts, pinning, D1, Streamable HTTP, credentials, SSRF/authorization, GitHub heavy executor.
- **R4 — settled (Q19–Q27)**: Publish activation/tool drift/secure secrets/protocol compat/trigger dedup/misfire/retry/OIDC/credentials.
- **R5 — settled (Q28–Q36)**: approval identity, pause, rotations, dedup namespace, DST, cancellation, result tiers, release gate, atomic tools.
- **R6 — settled (Q37–Q44)**: unknown-target authorization wait, atomic Publish, archive, restricted typed expressions, failure dependencies, quotas, async run, indeterminate state.
- **R7 — narrowed frontier requiring owner-level choices**:
  - Validate and freeze a canonical executable plan before publishing, or interpret the editable DSL each Run (depends on Q11/Q12/Q38/Q40).
  - Incompatible tool-schema drift at invocation: stop for repair/authorization or auto-adapt with AI (depends on Q20/Q28/Q37/Q40).
  - Saturation when limits are reached: explicit bounded rejection or introduce a persistent pending queue (depends on Q42).
  - Durable external callback correlation/recovery vs direct ephemeral notification (depends on Q26/Q33/Q44).
  - Required retention protection for active plans and artifacts vs fixed TTL even for active references (depends on Q12/Q34/Q39/Q35).
  - Granular MCP tool surface including workflow authoring and run inspection vs opportunistic proliferation of similarly named management tools (depends on Q36/Q43).
- **After R7**: propose **one consolidated technical specification**, including exact DSL/JSON Schema, MCP API schemas, state table, adapters/transport tests, D1/R2 schemas, GitHub Claim/callback contract, fault matrix, security measures, and CI/acceptance gates; highlight genuinely blocked items only. Seek explicit final consensus, not implementation approval.

### Technical feasibility / proof obligations (not settled decisions)

- Verify runtime HTTP networking protects against DNS rebinding and redirect/metadata SSRF; hostname string checks alone are insufficient.
- Verify recent/current MCP Streamable HTTP protocol versions by compatibility tests rather than assuming a certain revision.
- Specify authenticated encryption and Worker Secret lifecycle, redaction and revoke semantics without exposing the Portal bearer token.
- Verify GitHub OIDC authority, atomic single-claim, callback re-notification on lost signal, and truthful duplicate/late callback behavior.
- Prove that active immutable plans survive compatible deployments and that unsafe deployments fail closed.

## Working rules

1. Ask the complete current frontier in a round; offer one recommended choice per question.
2. Do not silently treat an earlier recommendation as an approved decision.
3. Once resolved, update terms and ADRs as appropriate; do not author implementation until the owner explicitly confirms shared understanding.
4. Challenge duplicate infrastructure and over-engineering explicitly.
