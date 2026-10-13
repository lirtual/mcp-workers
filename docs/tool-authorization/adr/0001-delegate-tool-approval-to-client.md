# ADR-0001 — Delegate MCP tool invocation approval to the client

Status: **Accepted for implementation planning; production authorization pending**. Date: 2026-10-13. Q1–Q19 decided (Q5 and Q8 superseded by Q14); Q20 is an operational test-approval artifact, not an architecture blocker.

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
- **Q8=A (Raindrop, superseded by Q14=B):** Originally approved separate preview and execute tools, but Q14=B explicitly rejects retaining preview and preserves current tool names for direct execution. No preview-only API remains after migration. See the superseding [Raindrop ADR-0003](../../../apps/raindrop-mcp-worker/docs/adr/0003-direct-cleanup-with-existing-tool-names.md).
- **Q9=A (Remote Control actual-client acceptance).** Before any separately authorized production release that removes file/Shell feature toggles, validate **real ChatGPT through the real Portal and MCP connection**, including tool discovery, correct read/write/Shell risk labeling, authenticated and unauthenticated requests, harmless file-write and Shell fixture behavior, receipts/uncertain results, and failure handling. Verify the effective Linux account privileges and outstanding T07/T09/T10 risks; do not infer that an approval prompt or "always allow" setting is guaranteed. Keep production file/Shell exposure unchanged unless the operator independently authorizes release. See [Remote Control ADR-0014](../../../docs/remote-control/adr/0014-real-client-tool-acceptance.md).

## Decisions confirmed in interview round 4

- **Q10=A (Database Hyperdrive DDL):** Keep schema-management / DDL tools restricted to **validated direct database transport**, even after each logical connection uses one credential. Do not infer that the new credential model makes Hyperdrive DDL safe or supported. Query and structured data mutations retain already-tested transport behavior; unsupported DDL returns a clear unsupported-transport error without fallback. See [Database ADR-0001](../../../apps/database-mcp-worker/docs/adr/0001-single-database-principal.md).
- **Q11 (Raindrop):** An explicit deletion intent must execute in **one client-to-Worker tool call** without a Worker-side confirm flag or repeat invocation. Later Q14=B additionally removes optional preview and preserves the existing tool names; this deliberately changes current default-preview semantics. See the superseding [Raindrop ADR-0003](../../../apps/raindrop-mcp-worker/docs/adr/0003-direct-cleanup-with-existing-tool-names.md).
- **Q12=B (Remote Control existing environment):** Use the **current connected ChatGPT / Portal / Worker / Linux Agent path** for real-client acceptance, not a separately maintained test environment. Limit any future authorized test to disposable fixture files and bounded harmless commands, with identity, VPC auth, receipts and T07/T09/T10 risk reviews. This is acceptance of the *test topology only*: **no permission is given to change production toggles, install a canary, alter credentials, run Shell or write real files in this round**. A separate explicit owner approval and a tested recovery path are required before any state-changing in-place trial. See [Remote Control ADR-0014](../../../docs/remote-control/adr/0014-real-client-tool-acceptance.md).

## Decisions confirmed in interview round 5

- **Q13=A — Database canonical `connection` field.** Every logical database record defines one `connection` field that identifies either a direct database URL or a Hyperdrive binding. No role-separated read/write/admin credential fields, no transitional compatibility parser, and no privilege escalation. Retain existing read/query limits and write affected-row limits. Concrete parseable examples belong in the Database ADR; the configured `DATABASE_CONFIG` remains a Cloudflare Secret and is not modified by this ADR.
- **Q14=B with clarification — Raindrop retain tool names and remove preview.** Continue using existing action names (for example `empty_trash`, `cleanup_collections`, `remove_duplicates`) and make each action directly execute **once** when called. Remove `confirm` and `dryRun` preview/approval parameters and do **not** add preview-only tools. This **explicitly supersedes Q5=A and Q8=A**. It is a **breaking semantic change**: calls with omitted parameters formerly produced only a preview, but after release will mutate or delete. Re-review descriptions, destructive annotations, argument schemas and client discovery cache; do not claim existing callers are backward-compatible. No backend confirmation or forced second call is introduced. See [Raindrop ADR-0003](../../../apps/raindrop-mcp-worker/docs/adr/0003-direct-cleanup-with-existing-tool-names.md).
- **Q15=A — Remote Control in-place, separately authorized test.** Acceptance on the existing Linux/Portal/ChatGPT path is required, with **read-only preflight first**, then a separately approved, narrowly scoped fixture write and harmless Shell test after identity, privilege paths, T07/T09/T10 blockers, safe recovery plan, and client-tool exposure are assessed. Choosing a test method does not approve gate changes, command execution, credentials, deployment or production cutover.
- **Q16=A — Unified rollout order in runbook.** Update the proposed manual release runbook order to **IMA → Raindrop → Database → Remote Control**. The GitHub Actions workflow remains `workflow_dispatch`-only for actual publication, and each release retains its own approval and verification. Changing a document on this design branch does not modify production.

## Decisions confirmed in interview round 6

- **Q17=A — Retain Raindrop deletion safety contracts.** Eliminate preview/confirmation stages only. Preserve existing deduplication eligibility (including conservative skipping of duplicates with notes or highlights where implemented), scope limitations, batch bounds, fail-fast behavior, per-scope succeeded/failed/unknown reporting, and no blind retry of ambiguous mutations. No new destructive reach or algorithm rewrite is authorized. Broad operations retain their documented original meaning but must describe their scope honestly.
- **Q18=A — Real client tool refresh is a release acceptance gate.** The `empty_trash`, `cleanup_collections`, and `remove_duplicates` names intentionally remain the same while their default side effects change. Before separately approving release, reconnect or refresh the actual ChatGPT MCP integration, verify `tools/list` and input schemas describe **direct deletion**, confirm destructive/non-read-only annotations are accurate, and record whether the actual client requests consent. Do not assert a prompt will always appear; an observed stale contract or tool cache blocks acceptance. Never perform a real cleanup just to prove metadata.
- **Q19=A — Allow separately approved short fail-closed Database maintenance.** The one-time `DATABASE_CONFIG` schema migration does not need a zero-downtime dual-parser design. A bounded interruption in which requests fail closed is acceptable during an independently authorized coordinated config/Worker release. Prepare the new secret out of GitHub, validate fixture connections and a recovery plan, verify the new active Worker and safe read after cutover; never silently choose legacy credentials or grant privileges. This decision does **not** authorize the interruption or Secret write now.

## Design interview exit criteria and residual release decisions

The core architectural design is **sufficient to proceed to implementation specification and isolated code PRs**: tool/ingress/resource boundaries, database config/transport/cutover, Raindrop single-call side effects, client refresh, Remote Control test method and release sequence are settled. No further open architectural question requires another grilling round.

- **Q20 (operational gate, not architecture):** The owner must separately grant explicit scoped permission for any future in-place Remote Control write/Shell test. The approval record must name the active Worker/host and scope, fixture path, harmless command, expected effects, gate or deployment change, readiness checks, stop/recovery plan and revocation/cleanup. This ADR supplies a proposed template in the implementation plan, **not the approval itself**.
- Per-Worker CI, static/live non-destructive acceptance, observed client approvals, credentials, source SHA, and actual active-version readback remain release evidence to gather, **not presumed results**.
- Independent approval is still required for implementation-PR merge, production Cloudflare Secret changes, each manual Worker deployment, Raindrop destructive live use and Remote Control gated test/exposure.
- The ordered, operator-controlled plan is maintained at [IMPLEMENTATION-PLAN.md](../IMPLEMENTATION-PLAN.md).

## Consequences to assess

**Potential benefits:** one less authorization/visibility system to maintain per Worker; consistent client-side tool choice; fewer deployment gates; simpler remote operations.

**Known costs/risks:** a bearer-holder or compromised client may exercise every tool reachable through the Worker's actual target identity; ChatGPT approval UX is not guaranteed, may vary by product, and cannot be set by a Worker; removing double confirmation shifts risk outward; database and Linux permissions remain crucial.

## Non-decisions

- No production gates, credentials, policies, or deployments are changed by this ADR.
- No claim that client approval can replace authentication or database/OS permission enforcement.
- Q4 retains query bounds, input validation and tool risk annotations; operation receipts, uncertain-result handling and secret-safe logging also remain, unless explicitly addressed by a separate future decision.
- Older app-specific ADRs remain authoritative until explicitly revised by an accepted decision.
