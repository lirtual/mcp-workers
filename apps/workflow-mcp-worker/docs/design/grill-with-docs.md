# Workflow MCP — Grill With Docs design record

Status: **Rounds 1–5 accepted; Round 6 in progress**  
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

## Round 5 consistency and over-engineering review

| Cross-decision seam | Conclusion | Remaining constraint |
| --- | --- | --- |
| Q7=B + Q28=A | **Compatible** | Any safely reachable supported MCP Server may be discovered without preregistration, but tool approval is for one actual target identity + tool + operation scope, never for globally matching tool names. Runtime-computed unknown targets need their own approval behavior (Round 6). |
| Q12=A + Q29=A + Q35=A | **Compatible** | Pause/disable stops **new admissions**, existing Runs retain their pinned Published Versions, and releases must preserve their executability. Deleting a definition while Runs are active is still undecided. |
| Q15=A + Q21=A + Q30=A | **Compatible** | Rotating an encrypted credential does not rewrite immutable Published Versions when target/scope remain identical. Revocation denies subsequent uses; it does not undo calls already sent. Key lifecycle and grant-version binding remain open. |
| Q23=A + Q31=A | **Compatible** | Deduplication is namespaced by Workflow/Trigger/source/event ID and finite retention, not a global request-body hash or permanent unlimited table. TTL and reuse after expiration are not yet decided. |
| Q24=A + Q32=A | **Compatible** | Cron timezone + `misfire: latest` combine with DST skip/dedupe; implementation must not create two logical occurrences when a clock repeats. Intended occurrence key remains open. |
| Q25=A + Q33=A | **Compatible; safety-critical** | Cancellation acknowledgement is not physical stop, and a lost write response is not evidence of failure. Keep truthful unknown-outcome semantics, without a full Saga rollback engine. |
| Q13=A + Q21=A + Q34=A | **Compatible** | D1 holds definitions, encrypted target credentials (separate key), small outputs and query facts. R2 holds only larger Artifact data. Neither is a second DAG scheduler. |
| Q18=A + Q26=A + Q27=A + Q35=A | **Compatible** | Registered GitHub heavy capability, OIDC + one Claim owner, separate minimal-scope credentials and release compatibility check. No second runner control-plane or broad multi-PAT authority. |
| Q36=A vs earlier 7-tool v0.1 | **Intentional supersession** | Original v0.1 read/run-only tool list is insufficient for Q5=B runtime draft authoring and publication. Add atomic management tools; avoid a generic mega-tool and avoid fragmenting CRUD into dozens of redundant primitives. |
| Overall overdesign review | **No added distributed platform required** | Do not introduce Redis/Queues-based scheduler, external Vault, worker-specific connection whitelist, n8n editor, role hierarchy, generic Saga, browser runtime sandbox or extra CI/deployment system solely for these decisions. |

## Reconciled historical v0.1 relationship

- **Superseded**: Git-only definitions and static MCP Connection registration (Q5=B, Q7=B), no runtime authoring (Q5=B), read/run-only seven-tool assumption (Q36=A).
- **Settled through Round 4**: runtime Draft/Publish, immutable Run version, Cloudflare Workflows/D1 and GitHub heavy execution, safe dynamic Streamable HTTP targets, encrypted target credentials, trigger families, idempotency/Claim and separated executor privileges (Q1–Q27).
- **Settled in Round 5**: specific target/tool/scope grants (Q28); pause independent from cancellation (Q29); no-republish same-scope credential rotation and revoke-denies-new-use (Q30); namespaced finite webhook deduplication (Q31); DST skip/dedupe (Q32); truthful best-effort cancellation (Q33); D1 small outputs plus R2 large Artifacts (Q34); nonterminal Run release compatibility gate (Q35); atomic MCP management tools (Q36).
- **Unsettled**: exact DSL, runtime dynamic target approval case, publishing concurrency/rollback, retention and delete/archive, graph condition/failure semantics, concurrency limits, executable tool API schemas, encryption key lifecycle, artifact access and TTL, concrete callback/dispatch protocol, migration gates, and acceptance tests.
- **Scope discipline**: None of Q28–Q36 authorizes implementation, any deployment, migration, file/credential provisioning, merging, or Tickets. A dynamic target authorization scope is **not** a static MCP endpoint registry.

## Design tree

- **R1 — settled (Q1–Q4)**: product, interface, monorepo boundary, v0.1 review.
- **R2 — settled (Q5–Q10)**: runtime authoring, bounded DAG, arbitrary MCP target, orchestrator, triggers, single owner.
- **R3 — settled (Q11–Q18)**: Draft/Publish, version identity, D1, Streamable HTTP, credentials, network safety, operation authorization, GitHub executor.
- **R4 — settled (Q19–Q27)**: publish activation, tool drift, encryption, protocol compatibility, trigger identity, Cron misfire, safe retry, OIDC/Claim, minimal execution authority.
- **R5 — settled (Q28–Q36)**: target+tool+scope approval, pause semantics, credential rotation/revoke, webhook dedup scope/retention, DST, truthful cancellation, output tiering, compatibility gate, atomic MCP tools.
- **R6 — unblocked design frontier (pending owner)**:
  - Runtime-computed/unseen target authorization for unattended runs (dependent on Q7/Q20/Q28).
  - Atomic Publish conflict/validation behavior and concurrent edits (dependent on Q5/Q11/Q19).
  - Definition archive/deletion while nonterminal Runs still reference a version (dependent on Q12/Q29/Q35).
  - Declarative expression language safety vs arbitrary evaluation (dependent on Q2/Q6/Q18).
  - DAG default dependency/failure/skip semantics (dependent on Q6/Q25).
  - Bounds on parallel ready Steps and fan-out, consistent with first-release bounded DAG (dependent on Q6).
  - Whether manual MCP start is always asynchronous or can hold an MCP request until completion (dependent on Q5/Q36).
  - Explicit indeterminate outcome representation across Run/Step/result/cancellation (dependent on Q25/Q33).
- **Later implementation-specific questions**: exact Tool schema/arguments, format and compiler validation, dynamic target grants and auth version identifiers, D1/R2 TTL and cleanup, envelope key rotation/recovery, callbacks/leases and migrations, fault matrix, CI gates and acceptance.

### Technical feasibility / evidence still needed (not user-decided facts)

- Confirm Cloudflare Worker networking can enforce the requested SSRF protections including DNS/redirect cases; do not assume hostname checks suffice.
- Confirm interoperability across *tested* current/recent MCP Streamable HTTP protocol revisions; do not guess exact supported revisions.
- Plan encrypted D1 key management, credential revocation and backup restore; never treat the Portal token as the encryption key.
- Cloudflare Workflows is the sole DAG progression owner; D1 holds coordination/query facts, not a second scheduler.
- GitHub Actions acceptance/dispatch acknowledgment is not business success; only the authorized Attempt Claim owner with valid result/callback can establish business completion.

## Working rules

1. Ask the complete current frontier in a round; offer one recommended choice per question.
2. Do not silently treat an earlier recommendation as an approved decision.
3. Once resolved, update terms and ADRs as appropriate; do not author implementation until the owner explicitly confirms shared understanding.
4. Challenge duplicate infrastructure and over-engineering explicitly.
