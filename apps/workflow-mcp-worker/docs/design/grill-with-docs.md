# Workflow MCP — Grill With Docs design record

Status: **Round 1 accepted; Round 2 in progress**  
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

## Baseline and limits

The historical Workflow MCP v0.1 technical specification dated 2026-09-18 was found in the owner's document library, not in the reviewed `main` tree. Its architectural candidates (Cloudflare Workflows, D1, R2, GitHub executor), DSL, state transitions, and security protocol are **proposals to re-check**; none are newly approved merely by Q4.

The current `main` tree was checked before this document: no `apps/workflow-mcp-worker` application existed. This branch is documentation-only; do not treat docs folders as implementation.

## Design tree

- **R1: Product & scope — settled**: Q1 product, Q2 interaction, Q3 repository boundary, Q4 review baseline.
- **R2: Definition / publishing / capability boundaries — open**: ask only independent, prerequisite-free questions; record responses before proceeding.
- **Future frontier (blocked on R2)**: definition identity/versioning, runtime topology, execution policies, idempotency/retry, authorization, reliability, release compatibility and acceptance.

## Working rules

1. Ask the complete current frontier in a round; offer one recommended choice per question.
2. Do not silently treat an earlier recommendation as an approved decision.
3. Once resolved, update terms and ADRs as appropriate; do not author implementation until the owner explicitly confirms shared understanding.
4. Challenge duplicate infrastructure and over-engineering explicitly.
