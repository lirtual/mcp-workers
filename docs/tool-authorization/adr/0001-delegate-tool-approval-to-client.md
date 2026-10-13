# ADR-0001 — Delegate MCP tool invocation approval to the client

Status: **Architecture decisions accepted; implementation and release pending**. Date: 2026-10-13. Q1=A Q2=B Q3=A Q4=A Q5=A (superseded by Q14) Q6=A Q7=A Q8=A (superseded by Q14) Q9=A Q10=A Q11=direct single-call delete Q12=B Q13=A Q14=B (no preview) Q15=A Q16=A.

This is an interview record, **not** authorization to deploy or remove production safeguards. The accepted decisions are recorded. User choices Q14 and Q16 supersede earlier Raindrop-preview and rollout-order assumptions. Execution tests, deployment and production changes remain separately authorized.

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
- **Q5=A (Raindrop, superseded by Q14=B):** Originally favored optional preview/dry-run. The later explicit Q14=B decision removes preview entirely. Client-owned approval remains.
- **Q6=A (Rollout):** Implement and verify one Worker at a time in this order: IMA, Raindrop, Database, Remote Control. Each stage needs regression tests and real-client tool discovery/invocation acceptance. Merge, deployment, and production activation remain separate steps needing the operator's approval.
  - **Runbook reconciliation:** Q16=A updates the runbook sequence in the same design branch; the existing `main` behavior and manual `workflow_dispatch` publication requirement remain unchanged until separately approved merge and release.

## Decisions confirmed in interview round 3

- **Q7=A (Database breaking configuration migration).** The target schema supplies a **single explicit database credential per logical connection**. After the agreed cutover, reject legacy `read`, `write`, or `admin` credential-shape fields with a clear migration error; do not implement a dual-format fallback, silently promote the previous read or admin credential, or modify credentials/grants automatically. Perform a deliberate operator-driven `DATABASE_CONFIG` migration before separately approved production deployment. The exact new field layout remains to be specified; see [Database ADR-0001](../../../apps/database-mcp-worker/docs/adr/0001-single-database-principal.md).
- **Q8=A (Raindrop, superseded by Q14=B):** Originally approved separate preview and execute tools, but Q14=B explicitly rejects retaining preview and preserves current tool names for direct execution. No preview-only API remains after migration. See [Raindrop ADR-0002](../../../apps/raindrop-mcp-worker/docs/adr/0002-optional-preview-client-consent.md).
- **Q9=A (Remote Control actual-client acceptance).** Before any separately authorized production release that removes file/Shell feature toggles, validate **real ChatGPT through the real Portal and MCP connection**, including tool discovery, correct read/write/Shell risk labeling, authenticated and unauthenticated requests, harmless file-write and Shell fixture behavior, receipts/uncertain results, and failure handling. Verify the effective Linux account privileges and outstanding T07/T09/T10 risks; do not infer that an approval prompt or "always allow" setting is guaranteed. Keep production file/Shell exposure unchanged unless the operator independently authorizes release. See [Remote Control ADR-0014](../../../docs/remote-control/adr/0014-real-client-tool-acceptance.md).

## Decisions confirmed in interview round 4

- **Q10=A (Database Hyperdrive DDL):** Keep schema-management / DDL tools restricted to **validated direct database transport**, even after each logical connection uses one credential. Do not infer that the new credential model makes Hyperdrive DDL safe or supported. Query and structured data mutations retain already-tested transport behavior; unsupported DDL returns a clear unsupported-transport error without fallback. See [Database ADR-0001](../../../apps/database-mcp-worker/docs/adr/0001-single-database-principal.md).
- **Q11 (Raindrop):** An explicit deletion intent must execute in **one client-to-Worker tool call** without a Worker-side confirm flag or repeat invocation. Later Q14=B additionally removes optional preview and preserves the existing tool names; this deliberately changes current default-preview semantics. See [Raindrop ADR-0002](../../../apps/raindrop-mcp-worker/docs/adr/0002-optional-preview-client-consent.md).
- **Q12=B (Remote Control existing environment):** Use the **current connected ChatGPT / Portal / Worker / Linux Agent path** for real-client acceptance, not a separately maintained test environment. Limit any future authorized test to disposable fixture files and bounded harmless commands, with identity, VPC auth, receipts and T07/T09/T10 risk reviews. This is acceptance of the *test topology only*: **no permission is given to change production toggles, install a canary, alter credentials, run Shell or write real files in this round**. A separate explicit owner approval and a tested recovery path are required before any state-changing in-place trial. See [Remote Control ADR-0014](../../../docs/remote-control/adr/0014-real-client-tool-acceptance.md).

## Decisions confirmed in interview round 5

- **Q13=A — Database canonical `connection` field.** Every logical database record defines one `connection` field that identifies either a direct database URL or a Hyperdrive binding. No role-separated read/write/admin credential fields, no transitional compatibility parser, and no privilege escalation. Retain existing read/query limits and write affected-row limits. Concrete parseable examples belong in the Database ADR; the configured `DATABASE_CONFIG` remains a Cloudflare Secret and is not modified by this ADR.
- **Q14=B with clarification — Raindrop retain tool names and remove preview.** Continue using existing action names (for example `empty_trash`, `cleanup_collections`, `remove_duplicates`) and make each action directly execute **once** when called. Remove `confirm` and `dryRun` preview/approval parameters and do **not** add preview-only tools. This **explicitly supersedes Q5=A and Q8=A**. It is a **breaking semantic change**: calls with omitted parameters formerly produced only a preview, but after release will mutate or delete. Re-review descriptions, destructive annotations, argument schemas and client discovery cache; do not claim existing callers are backward-compatible. No backend confirmation or forced second call is introduced.
- **Q15=A — Remote Control in-place, separately authorized test.** Acceptance on the existing Linux/Portal/ChatGPT path is required, with **read-only preflight first**, then a separately approved, narrowly scoped fixture write and harmless Shell test after identity, privilege paths, T07/T09/T10 blockers, safe recovery plan, and client-tool exposure are assessed. Choosing a test method does not approve gate changes, command execution, credentials, deployment or production cutover.
- **Q16=A — Unified rollout order in runbook.** Update the proposed manual release runbook order to **IMA → Raindrop → Database → Remote Control**. The GitHub Actions workflow remains `workflow_dispatch`-only for actual publication, and each release retains its own approval and verification. Changing a document on this design branch does not modify production.

## Unresolved decision frontier

1. **Q17 — Raindrop execution scope and safeguards:** confirm that `remove_duplicates` retains its existing conservative skip/partial-result safeguards even though preview disappears; decide any explicit source/target requirement for broad cleanup.
2. **Q18 — Breaking client-tool refresh:** choose an explicit reconnect/re-discovery acceptance gate for changed destructive Raindrop tool semantics versus no operational refresh requirement.
3. **Q19 — Database one-time configuration cutover:** decide whether a separately approved short fail-closed maintenance interval is acceptable or zero-downtime migration is mandatory (which may require additional deployment coordination).
4. **Q20 — Remote Control authorization record:** define what constitutes the later explicit, bounded owner approval for temporary in-place writes/Shell testing, without granting it in this design round.

## Consequences to assess

**Potential benefits:** one less authorization/visibility system to maintain per Worker; consistent client-side tool choice; fewer deployment gates; simpler remote operations.

**Known costs/risks:** a bearer-holder or compromised client may exercise every tool reachable through the Worker's actual target identity; ChatGPT approval UX is not guaranteed, may vary by product, and cannot be set by a Worker; removing double confirmation shifts risk outward; database and Linux permissions remain crucial.

## Non-decisions

- No production gates, credentials, policies, or deployments are changed by this ADR.
- No claim that client approval can replace authentication or database/OS permission enforcement.
- Q4 retains query bounds, input validation and tool risk annotations; operation receipts, uncertain-result handling and secret-safe logging also remain, unless explicitly addressed by a separate future decision.
- Older app-specific ADRs remain authoritative until explicitly revised by an accepted decision.
