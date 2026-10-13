# ADR-0001 — Delegate MCP tool invocation approval to the client

Status: **Proposed, partially decided**. Date: 2026-10-13.

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

## Unresolved decision frontier

1. **Q2 — Database credential model.** Keep distinct READ / WRITE / ADMIN configured credentials and structured SQL guardrails, or simplify to a single DB principal whose actual database grants define all available capabilities? The operator requested a plain-language explanation before deciding.
2. After Q2, decide the exact tool contract / capability exposure implications and any validation or limits that remain necessary for correctness versus permission management.
3. Decide how to stage the four-Worker behavior change and verify each client's real tool exposure and approval behavior before production cutover.

## Consequences to assess

**Potential benefits:** one less authorization/visibility system to maintain per Worker; consistent client-side tool choice; fewer deployment gates; simpler remote operations.

**Known costs/risks:** a bearer-holder or compromised client may exercise every tool reachable through the Worker's actual target identity; ChatGPT approval UX is not guaranteed, may vary by product, and cannot be set by a Worker; removing double confirmation shifts risk outward; database and Linux permissions remain crucial.

## Non-decisions

- No production gates, credentials, policies, or deployments are changed by this ADR.
- No claim that client approval can replace authentication or database/OS permission enforcement.
- No decision yet to remove query bounds, input validation, idempotency/receipt logic, log redaction, or capability risk annotations.
- Older app-specific ADRs remain authoritative until explicitly revised by an accepted decision.
