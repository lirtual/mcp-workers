# Workflow MCP — Grill With Docs design record

Status: **Rounds 1–2 accepted; Round 3 in progress**  
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

## Baseline and limits

The historical Workflow MCP v0.1 technical specification dated 2026-09-18 was found in the owner's document library, not in the reviewed `main` tree. Q8=A now confirms Cloudflare Workflows with D1 coordination and query facts. Other architectural candidates (R2, GitHub executor), DSL details, persistence schemas, state transitions, transport, and security protocols remain **proposals to re-check** unless confirmed separately.

## Explicitly superseded historical assumptions

- **Q5=B** overrides the older v0.1 **Git/source-controlled definitions only; no runtime authoring** restriction. A runtime-backed create/edit/publish path is now mandatory. The user did **not** decide whether editing is draft-first, whether publish is atomic, or what a live update does to in-flight Runs.
- **Q7=B** overrides the older v0.1 **static MCP Connection metadata, no runtime connection administration, no arbitrary MCP endpoint** restriction. Any MCP Server may be discovered and invoked without preregistration. The user did **not** decide transport support, credential delegation, SSRF boundaries, tool approval rules, or error/retry semantics.
- **Q6=A** rejects both sequential-only execution and full n8n-style dynamic graph/loop features at first release.
- **Q8=A** confirms the orchestrator, but does **not** approve GitHub Actions as a heavy executor or specify an executor protocol.
- **Q9=A and Q10=A** settle available trigger families and single-owner scope, not specific network/webhook security or authorization mechanics.

The current `main` tree was checked before this document: no `apps/workflow-mcp-worker` application existed. This branch is documentation-only; do not treat docs folders as implementation.

## Design tree

- **R1: Product & scope — settled**: Q1 product, Q2 interaction, Q3 repository boundary, Q4 review baseline.
- **R2: Definition / publishing / capability boundaries — settled**: Q5 runtime publish, Q6 bounded DAG, Q7 dynamic any MCP, Q8 Cloudflare Workflows, Q9 trigger types, Q10 single-owner.
- **R3: Unblocked dependent questions — open**: publication lifecycle, immutable run snapshots, transport coverage, dynamic MCP authentication, SSRF/network policy, side-effect authority, and heavy executor scope.
- **Later branches (blocked on R3 answers)**: schema/API detail, credential persistence and rotation, redaction, precise reliability, idempotency/retry policies, external claims, scheduler misfires, migration/release compatibility and acceptance.

## Working rules

1. Ask the complete current frontier in a round; offer one recommended choice per question.
2. Do not silently treat an earlier recommendation as an approved decision.
3. Once resolved, update terms and ADRs as appropriate; do not author implementation until the owner explicitly confirms shared understanding.
4. Challenge duplicate infrastructure and over-engineering explicitly.
