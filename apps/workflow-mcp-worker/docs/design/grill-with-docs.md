# Workflow MCP — Grill With Docs design record

Status: **Rounds 1–4 accepted; Round 5 in progress**  
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

## Baseline and limits

The historical Workflow MCP v0.1 technical specification dated 2026-09-18 was found in the owner's document library, not in the reviewed `main` tree. Decisions Q1–Q18 now supersede the parts explicitly described below. The remaining earlier proposals are not automatically ratified.

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

## Round 4 consistency and over-engineering review

| Topic | Finding | Open dependency / interpretation |
| --- | --- | --- |
| Q11 vs Q17 vs Q19 (Publish/Enable) | **Resolved** | Publish validates, obtains required Operation Authorization and activates. No separate mandatory Enable action. Pause/disable is allowed, but its effect on in-flight Runs is not decided. |
| Q7 vs Q20 (any MCP vs tool approval) | **Compatible** | No preregistered Server allowlist. Operation authorization must not silently expand to new high-risk tools, stronger permissions or incompatible contracts. Identity/grant binding of dynamic targets is unresolved. |
| Q13 vs Q21 (D1 definitions vs credentials) | **Compatible, separated concerns** | D1 stores definitions and encrypted target credentials; no plaintext credentials or global Portal-token forwarding. Key lifecycle and credential-grant identity remain unresolved. |
| Q14 vs Q22 (transport vs versions) | **Compatible** | Streamable HTTP first, with validated current/recent protocol versions. Old SSE/stdio transport support remains deferred. Supported exact revisions/negotiation are not yet selected. |
| Q23 vs Q25 (duplicate delivery vs repeated side effect) | **Both needed** | Event admission deduplication prevents two logical Runs from the same webhook, but cannot substitute for per-step idempotency and uncertain-write reconciliation. |
| Q24 vs bounded Cron | **Compatible** | Explicit timezone and `misfire: latest` avoid unbounded catch-up. DST, intended occurrence identity and dedup retention are still unsettled. |
| Q26 vs GitHub dispatch ambiguity | **Relevant safety cost** | OIDC + atomic Attempt Claim addresses multiple candidates after ambiguous dispatch. The rest of the lease/callback/cancel protocol is not approved by this choice. |
| Q27 vs existing management MCP | **Privilege boundary confirmed** | GitHub Actions management MCP may hold multi-account PATs; Workflow executor gets its own minimum-scope identity. Avoid a new PAT router or redundant repository authorization layer. |
| New infrastructure | **Reject unnecessary complexity** | No separate Vault, Redis/BullMQ, Temporal deployment, full AI-agent sandbox, generic Saga engine, custom DAG scheduler, standalone plugin marketplace or multitenant RBAC were selected. |
| Runtime security feasibility | **Must still prove at implementation** | Encryption key bootstrap/rotation, SSRF redirect/rebinding enforcement in Workers, MCP version compatibility, claim atomicity and engine upgrade safety are real constraints. A design vote is not a successful integration test. |

## Refined historical v0.1 relationship

- **Superseded**: Git-only definitions, fixed MCP Connection registration, no runtime authoring (Q5=B, Q7=B).
- **Newly settled**: Draft/Publish/version pinning (Q11–Q13); dynamic Streamable HTTP plus stored targeted credentials/network safeguards/approval (Q14–Q17); registered GitHub heavy execution (Q18); Publish-and-authorize activation, reapproval on tool drift, encrypted D1 credentials, current/recent Streamable HTTP compatibility, stable webhook event identity, timezone and latest Cron misfires, safety-sensitive retries, OIDC Claim and execution credential isolation (Q19–Q27).
- **Not yet approved**: exact DSL/API schemas, target/operation binding, key rotation/revocation, Webhook dedup retention, DST semantics, cancellation behavior, run/result retention, multi-version engine upgrade rules, precise GitHub Claim/lease/callback implementation, R2 usage, and validation/acceptance gates.
- **No silent reinterpretation**: A worker can reach an arbitrary *safe network* Streamable HTTP MCP target without prior registration. Enforcing secure operation grants and SSRF boundaries is not a static MCP connection allowlist. Only **heavy runner capabilities** require preregistration.

## Design tree

- **R1 — settled (Q1–Q4)**: product positioning, AI/MCP interface, independent monorepo context, historical review baseline.
- **R2 — settled (Q5–Q10)**: runtime authoring, bounded DAG, arbitrary unregistered MCP targets, Cloudflare Workflows, triggers, single owner.
- **R3 — settled (Q11–Q18)**: draft/publish, run version identity, D1, Streamable HTTP, target credentials, SSRF defense, operation authority, GitHub heavy executor.
- **R4 — settled (Q19–Q27)**: publish activation; tool drift reauthorization; encrypted D1 credentials; tested recent protocol versions; webhook event ID; Cron misfire; safe retry; OIDC claim; distinct runner credentials.
- **R5 — newly unblocked frontier (open for owner)**:
  - binding of an Operation Authorization to a dynamic target/tool and its behavior when target/tool selection varies at runtime;
  - pause/disable behavior for in-flight Runs;
  - target credential rotation/revocation and already-approved workflow operation;
  - webhook event identity scope and deduplication retention;
  - timezone/DST semantics for Cron intended occurrences;
  - external task cancellation and unknown-outcome reporting;
  - large outputs/artifact storage and retention;
  - compatibility gates for engine/runner deployments while Runs remain active;
  - runtime management versus run-observation MCP tool granularity.
- **Later dependent branches**: detailed DSL/expression/schema compile rules, input/parameter validation, bounded DAG errors/parallelism, exact encryption and identity protocol, GitHub dispatch Claim lease/callback/reconciliation, lifecycle event/API schemas, quotas, CI/release test gates and final acceptance.

### Technical verification notes (not settled decisions)

- Cloudflare Worker networking must support the required SSRF defenses; hostname-only checks and trusting redirects are not enough.
- Choose concrete supported MCP Streamable HTTP protocol revisions from tested interoperability, not guessed version strings. Reference: https://modelcontextprotocol.io/specification
- D1 encrypted credential storage still requires appropriate authenticated encryption, key lifecycle and redaction tests. Never treat the Portal bearer token as the encryption master key.
- A GitHub dispatch acknowledgement is not proof of business execution or success; Attempt Claim and result/callback validation have different responsibilities.

## Working rules

1. Ask the complete current frontier in a round; offer one recommended choice per question.
2. Do not silently treat an earlier recommendation as an approved decision.
3. Once resolved, update terms and ADRs as appropriate; do not author implementation until the owner explicitly confirms shared understanding.
4. Challenge duplicate infrastructure and over-engineering explicitly.
