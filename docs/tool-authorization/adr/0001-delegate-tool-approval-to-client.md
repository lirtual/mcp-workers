# ADR-0001 — Delegate MCP tool invocation approval to the client

Status: **Proposed implementation; Q1–Q10 and Q12 decided; Q11 one-call intent settled, naming pending**. Date: 2026-10-13. Rounds: Q1=A, Q2=B, Q3=A, Q4=A, Q5=A, Q6=A, Q7=A, Q8=A, Q9=A; Q10=A, Q11=one-call direct execution with optional preview, Q12=B.

This is an interview record, **not** authorization to deploy or remove production safeguards. The accepted decisions are recorded; some public API details, rollout evidence and production authorizations remain unresolved.

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
- **Q2=B — Database connection principal.** Each logical database connection will use **one configured upstream database credential/principal** for its supported query, mutation and schema operations. The upstream database's actual grants remain authoritative; the client approval neither confers privileges nor silently promotes the account. Read, structured mutation and schema tools remain distinct per Q4=A; arbitrary general SQL is not introduced. See [Database ADR-0001](../../../apps/database-mcp-worker/docs/adr/0001-single-database-principal.md).

## Decisions confirmed in interview round 2

- **Q4=A (Database):** Retain distinct query, structured data mutation, and schema tools with accurate tool risk metadata, SQL validation, execution limits, and result reporting. Each logical connection uses the one database principal already decided; these are tool contracts, not separate Worker permissions.
- **Q5=A (Raindrop):** Retain optional preview/dry-run functionality for cleanup. Remove redundant Worker-required confirmation: the client is responsible for presenting consent to its user. A preview is not a guarantee that the target remains unchanged.
- **Q6=A (Rollout):** Implement and verify one Worker at a time in this order: IMA, Raindrop, Database, Remote Control. Each stage needs regression tests and real-client tool discovery/invocation acceptance. Merge, deployment, and production activation remain separate steps needing the operator's approval.
  - **Existing release-contract mismatch:** `docs/manual-worker-release.md` currently lists Raindrop before IMA and uses **manual `workflow_dispatch`** as the only publisher. The confirmed Q6 rollout order is IMA before Raindrop. Reconcile the operational runbook as part of implementation planning **before** any production release; this ADR does not change the active release runbook or authorize a new publishing trigger.

## Decisions confirmed in interview round 3

- **Q7=A (Database breaking configuration migration).** The target schema supplies a **single explicit database credential per logical connection**. After the agreed cutover, reject legacy `read`, `write`, or `admin` credential-shape fields with a clear migration error; do not implement a dual-format fallback, silently promote the previous read or admin credential, or modify credentials/grants automatically. Perform a deliberate operator-driven `DATABASE_CONFIG` migration before separately approved production deployment. The exact new field layout remains to be specified; see [Database ADR-0001](../../../apps/database-mcp-worker/docs/adr/0001-single-database-principal.md).
- **Q8=A (Raindrop split preview and execute tools).** For cleanup operations, distinct **read-only preview** and **destructive execute** tool contracts replace in-band `confirm:true` / `dryRun` approval semantics. A client can execute without first previewing, but the tool name, input schema and risk annotations must clearly communicate destructive behavior; no legacy preview-shaped invocation may be silently interpreted as execution. See [Raindrop ADR-0002](../../../apps/raindrop-mcp-worker/docs/adr/0002-optional-preview-client-consent.md).
- **Q9=A (Remote Control actual-client acceptance).** Before any separately authorized production release that removes file/Shell feature toggles, validate **real ChatGPT through the real Portal and MCP connection**, including tool discovery, correct read/write/Shell risk labeling, authenticated and unauthenticated requests, harmless file-write and Shell fixture behavior, receipts/uncertain results, and failure handling. Verify the effective Linux account privileges and outstanding T07/T09/T10 risks; do not infer that an approval prompt or "always allow" setting is guaranteed. Keep production file/Shell exposure unchanged unless the operator independently authorizes release. See [Remote Control ADR-0014](../../../docs/remote-control/adr/0014-real-client-tool-acceptance.md).

## Decisions confirmed in interview round 4

- **Q10=A (Database Hyperdrive DDL):** Keep schema-management / DDL tools restricted to **validated direct database transport**, even after each logical connection uses one credential. Do not infer that the new credential model makes Hyperdrive DDL safe or supported. Query and structured data mutations retain already-tested transport behavior; unsupported DDL returns a clear unsupported-transport error without fallback. See [Database ADR-0001](../../../apps/database-mcp-worker/docs/adr/0001-single-database-principal.md).
- **Q11 (Raindrop, operator clarification):** An explicit deletion intent must execute in **one client-to-Worker tool call**, without mandatory preview, confirmation flag, or repeat invocation. A separate read-only preview capability remains optional under Q5=A/Q8=A: separate **capabilities do not mean a mandatory two-step workflow**. This clarifies rather than revokes Q8. Since existing `empty_trash` and `cleanup_collections` default to preview without `confirm:true`, and `remove_duplicates` defaults `dryRun:true`, the exact legacy name retirement and new executable naming must be chosen before implementing a potentially breaking destructive change; no old preview-only call may silently become deletion. See [Raindrop ADR-0002](../../../apps/raindrop-mcp-worker/docs/adr/0002-optional-preview-client-consent.md).
- **Q12=B (Remote Control existing environment):** Use the **current connected ChatGPT / Portal / Worker / Linux Agent path** for real-client acceptance, not a separately maintained test environment. Limit any future authorized test to disposable fixture files and bounded harmless commands, with identity, VPC auth, receipts and T07/T09/T10 risk reviews. This is acceptance of the *test topology only*: **no permission is given to change production toggles, install a canary, alter credentials, run Shell or write real files in this round**. A separate explicit owner approval and a tested recovery path are required before any state-changing in-place trial. See [Remote Control ADR-0014](../../../docs/remote-control/adr/0014-real-client-tool-acceptance.md).

## Unresolved decision frontier

1. **Q13 — Database single-credential configuration shape:** choose a small canonical connection format for direct URLs and Hyperdrive binding, while preserving existing runtime limits and failing closed on legacy shapes.
2. **Q14 — Raindrop old-tool name cutover:** choose new, explicit execution tool names and retirement of legacy preview-default names versus a compatibility design that cannot silently turn omitted flags into deletion. No second confirmation step is desired.
3. **Q15 — Remote Control in-place acceptance plan:** specify the minimum evidence and staged authorization needed for a safe trial on the existing environment while existing production write and Shell gates stay disabled until independently approved.
4. **Q16 — Release runbook ordering:** decide whether to update the active manual-release runbook to the approved cross-Worker sequence before implementation or keep an explicit separate security release dependency; production publishing remains `workflow_dispatch` and is never automatically authorized by documentation alone.

## Consequences to assess

**Potential benefits:** one less authorization/visibility system to maintain per Worker; consistent client-side tool choice; fewer deployment gates; simpler remote operations.

**Known costs/risks:** a bearer-holder or compromised client may exercise every tool reachable through the Worker's actual target identity; ChatGPT approval UX is not guaranteed, may vary by product, and cannot be set by a Worker; removing double confirmation shifts risk outward; database and Linux permissions remain crucial.

## Non-decisions

- No production gates, credentials, policies, or deployments are changed by this ADR.
- No claim that client approval can replace authentication or database/OS permission enforcement.
- Q4 retains query bounds, input validation and tool risk annotations; operation receipts, uncertain-result handling and secret-safe logging also remain, unless explicitly addressed by a separate future decision.
- Older app-specific ADRs remain authoritative until explicitly revised by an accepted decision.
