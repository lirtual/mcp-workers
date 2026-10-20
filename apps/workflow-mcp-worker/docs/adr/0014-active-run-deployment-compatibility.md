---
status: accepted
date: 2026-10-20
---

# Check nonterminal Run compatibility before automated engine deployment

New Workflow MCP engine/runner deployments check whether the candidate versions can continue all existing nonterminal Runs, including their pinned Published Versions and required protocol/capability revisions (**Q35=A**). Compatible releases can proceed through the existing automated pipeline; incompatible releases must be blocked or use an explicitly reviewed safe migration. Always deploying and hoping older executions recover is not an acceptable default. This protects long-running and waiting Runs without adding a second deployment control plane.

## Rejected alternative

- Deploy any new engine/runner version unconditionally and recover older Runs on a best-effort basis.

## Consequences

The precise compatibility matrix, definition snapshot retention, checking source of truth, deploy rollback/migration procedure, migration authority and automated-gate wiring remain **open**. GitHub executor jobs cannot be treated as proof that the orchestrator's stored protocol and Run state are compatible. Only compatibility checks are authorized as design decisions here; no code, release automation changes, deployment, merge or Tickets are authorized.
