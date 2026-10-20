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

## Working rules

1. Ask the complete current frontier in a round; offer one recommended choice per question.
2. Do not silently treat an earlier recommendation as an approved decision.
3. Once resolved, update terms and ADRs as appropriate; do not author implementation until the owner explicitly confirms shared understanding.
4. Challenge duplicate infrastructure and over-engineering explicitly.
