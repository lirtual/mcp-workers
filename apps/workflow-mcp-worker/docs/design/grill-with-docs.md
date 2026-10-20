# Workflow MCP — Grill With Docs design record

Status: **Rounds 1–3 accepted; Round 4 in progress**  
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

## Round 3 consistency and over-engineering review

| Topic | Review result | Boundary / remaining question |
| --- | --- | --- |
| Dynamic target vs registered heavy capability | **Compatible, different domains** | MCP targets need no preregistration; the platform's privileged GitHub runner capabilities are registered. |
| Dynamic target vs SSRF protection | **Compatible** | Network safety is a target-class prohibition, not a preapproved host list. Precise DNS/redirect enforcement requires an implementation feasibility check. |
| Runtime publication vs version pinning | **Compatible and necessary** | D1 Published Version identity must be immutable; the Run references it. Physical snapshot/retention remains open. |
| Published vs enabled | **Terminology gap** | Q11 requires Publish, Q17 requires authorization on Enable. Whether publication itself enables manual runs/automated triggers, or Enable is a distinct state, is **not settled**. |
| Dynamic tool changes vs unattended approval | **Unresolved authority risk** | Approval of unknown future tools or dynamically computed endpoints could bypass Q17. Decide the identity/approval boundary in Round 4. |
| D1 definitions vs target credentials | **Do not conflate** | Q13 selects D1 for definitions; Q15 only requires secure target-specific credential retention. No plaintext D1, vault architecture or Cloudflare admin API token was approved. |
| GitHub Actions admin MCP vs heavy executor | **Must remain separate** | The user-facing GitHub Actions MCP has multi-PAT repository privileges. Do not silently reuse these broad privileges for heavy execution. |
| D1 + Cloudflare Workflows responsibilities | **No duplicate engine** | Cloudflare Workflows advances the DAG; D1 holds durable coordination/query facts and definitions, not an independent scheduler. |
| Platform-feature creep | **Deferred** | Avoid a visual editor, generic sandbox, loop/fan-out engine, Redis/Queues/Temporal duplication, OAuth broker for all providers, multi-tenant RBAC, or new secrets-management service until proved necessary. |

### External technical facts to check before implementation (not decisions)

- The 2026-07-28 MCP Streamable HTTP revision has important compatibility differences from older 2025 revisions; transport name alone is insufficient to define protocol interoperability. Reference: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/transports/streamable-http.mdx
- Cloudflare Secrets Store read bindings are configured/deployed resources; runtime owner-created target credentials should not be assumed to be writable as bound secrets without an account-level management API and added privileges. References: https://developers.cloudflare.com/secrets-store/integrations/workers/ and https://developers.cloudflare.com/secrets-store/access-control/
- Cloudflare Workflows instance retention is finite; pinning a Run to a definition and resuming through deployments requires an explicit compatibility/retention design. Reference: https://developers.cloudflare.com/workflows/build/workers-api/

## Design tree

- **R1: Product & scope — settled**: Q1–Q4.
- **R2: Definition / publishing / capability boundaries — settled**: Q5–Q10.
- **R3: Dynamic runtime + security architecture — settled**: Q11–Q18.
- **R4: Unblocked dependent questions — open**:
  - publication/enable distinction and how existing Runs behave on disable/delete;
  - authority of discovered target/tool drift and unattended approval;
  - credential-at-rest mechanism for owner-managed target credentials;
  - webhook identity/deduplication requirements;
  - Cron timezone and missed-trigger policy;
  - retry policy for uncertain externally-effectful operations;
  - GitHub heavy-executor dispatch duplication/Claim ownership protocol;
  - compatibility boundaries between MCP transport protocol revisions.
- **Later branches**: exact MCP tool/API/DSL syntax, auth grants/credential rotation, workflow-version garbage collection, error state machine, callback/cancel/reconciliation, GitHub runner authorization, quotas, CI/releases, integration tests and acceptance.

## Working rules

1. Ask the complete current frontier in a round; offer one recommended choice per question.
2. Do not silently treat an earlier recommendation as an approved decision.
3. Once resolved, update terms and ADRs as appropriate; do not author implementation until the owner explicitly confirms shared understanding.
4. Challenge duplicate infrastructure and over-engineering explicitly.
