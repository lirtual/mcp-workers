# ADR-0001 — Delegate MCP tool invocation approval to the client

Status: **Proposed, partially decided**. Date: 2026-10-13. Interview rounds 1 and 2: Q1=A Q2=B Q3=A Q4=A Q5=A Q6=A.

This is an interview record, **not** authorization to deploy or remove production safeguards. The operator's desired direction is recorded; the specific removal scope and migration contracts remain unresolved.

## Context

The active mcp-workers repository contains four MCP Worker contexts: Database, IMA, Raindrop, and Remote Control. They use different mechanisms that can be confused under the label “tool permissions”:

- Remote Control filters tool availability and invocation based on `REMOTE_CONTROL_ENABLE_FILE_WRITES` and `REMOTE_CONTROL_ENABLE_SHELL`.
- IMA has a `registerTools(..., allowWrite)` branch, but the current runtime passes `true`.
- Database separates read, write, and admin credentials, restricts SQL operations, and requires a protocol-level confirmation for destructive schema changes.
- Raindrop defines operation contracts for potentially destructive cleanup and uncertain write outcomes.

The operator requested that read/write tool invocation decisions belong to the MCP client (e.g. ChatGPT), rather than duplicating a tool-permission management layer in every Worker. This direction is distinct from allowing unauthenticated access or granting additional authority in target systems.

MCP tool annotations describe risk but do not enforce authorization. Different MCP clients may apply different approval policies. A client prompt cannot substitute for server-side identity and resource authorization.

## Direction recorded from the operator

1. Aim for a **complete, truthful client-visible tool surface** without extra Worker-specific read/write feature toggles or duplicate approval UX.
2. Treat the **MCP client** as the owner of the user-facing tool invocation approval policy.
3. Avoid increasing code and configuration complexity with a centralized tool permission manager.

## Decisions confirmed in interview round 1

- **Q1=A — Scope of removal.** Remove Worker-maintained tool visibility/enablement gates and duplicated per-call tool approval; **retain** MCP ingress authentication, target-resource authority (database / OS privileges), request validation, operation integrity and failure handling. This does not authorize unauthenticated access.
- **Q3=A — User-facing confirmation ownership.** Client-side policy owns user-facing confirmation, including destructive DDL; the intended design removes the Worker's duplicate MCP protocol-level confirmation step for such operations. The Worker retains truthful risk annotations and execution safety contracts. Client implementations may approve calls without prompting; this is an accepted architectural trade-off, not a guarantee of a prompt or 'always allow' control.
- **Q2=B — Database connection principal.** Each logical database connection will use **one configured upstream database credential/principal** for its supported query, mutation and schema operations. The upstream database's actual grants remain authoritative; the client approval neither confers privileges nor silently promotes the account. This does **not** decide whether to keep distinct MCP tools for read/write/admin operations or accept arbitrary SQL. See [Database ADR-0001](../../../apps/database-mcp-worker/docs/adr/0001-single-database-principal.md).

## Decisions confirmed in interview round 2

- **Q4=A (Database):** Retain distinct query, structured data mutation, and schema tools with accurate tool risk metadata, SQL validation, execution limits, and result reporting. Each logical connection uses the one database principal already decided; these are tool contracts, not separate Worker permissions.
- **Q5=A (Raindrop):** Retain optional preview/dry-run functionality for cleanup. Remove redundant Worker-required confirmation: the client is responsible for presenting consent to its user. A preview is not a guarantee that the target remains unchanged.
- **Q6=A (Rollout):** Implement and verify one Worker at a time in this order: IMA, Raindrop, Database, Remote Control. Each stage needs regression tests and real-client tool discovery/invocation acceptance. Merge, deployment, and production activation remain separate steps needing the operator's approval.
  - **Existing release-contract mismatch:** `docs/manual-worker-release.md` currently lists Raindrop before IMA and uses **manual `workflow_dispatch`** as the only publisher. The confirmed Q6 rollout order is IMA before Raindrop. Reconcile the operational runbook as part of implementation planning **before** any production release; this ADR does not change the active release runbook or authorize a new publishing trigger.

## Unresolved decision frontier

1. **Q7:** Single-database-credential configuration migration: deliberate breaking change with a validation error for legacy shapes, or temporary dual-schema support?
2. **Q8:** Raindrop optional preview interface: required preview/execute mode on each cleanup tool, or separate preview and execute tools?
3. **Q9:** Remote Control: pre-release verification and explicit approval criteria before changing its production tool availability.

## Consequences to assess

**Potential benefits:** one less authorization/visibility system to maintain per Worker; consistent client-side tool choice; fewer deployment gates; simpler remote operations.

**Known costs/risks:** a bearer-holder or compromised client may exercise every tool reachable through the Worker's actual target identity; ChatGPT approval UX is not guaranteed, may vary by product, and cannot be set by a Worker; removing double confirmation shifts risk outward; database and Linux permissions remain crucial.

## Non-decisions

- No production gates, credentials, policies, or deployments are changed by this ADR.
- No claim that client approval can replace authentication or database/OS permission enforcement.
- No decision yet to remove query bounds, input validation, idempotency/receipt logic, log redaction, or capability risk annotations.
- Older app-specific ADRs remain authoritative until explicitly revised by an accepted decision.
