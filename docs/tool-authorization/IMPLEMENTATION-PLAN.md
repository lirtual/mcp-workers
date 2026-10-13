# Client-owned MCP tool approval — implementation and acceptance plan

Status: **Architecture interview complete; implementation plan proposed** (2026-10-13). The source decisions are [ADR-0001](./adr/0001-delegate-tool-approval-to-client.md) and the relevant Database, Raindrop, and Remote Control ADRs. **No implementation, deployment, production configuration, credential, or live mutation has been authorized by this plan.**

## Goal and definition of success

Four existing Workers (IMA, Raindrop, Database, Remote Control) expose their supported read and mutation tools consistently. The MCP client, such as ChatGPT, owns interactive tool-call approval rather than each Worker hiding capabilities behind extra read/write toggles or demanding duplicate confirmations.

Retain these **independent boundaries**: `MCP_ACCESS_TOKEN` and upstream/device authentication; permissions enforced by the target MySQL/PostgreSQL server or Linux user; input and SQL validation; bounded operations, concurrency/rate limits, operation receipts, no blind retries, and safe failure/observability. The target is **not** anonymous access, arbitrary SQL, automatic database privilege elevation, new Linux root/admin access, or a new centralized permission system. Risk annotations are advisory, **not** an assurance of a ChatGPT confirmation dialog.

## Decisions fixed by grilling

- Q1=A, Q3=A: eliminate duplicated tool-permission switches and server-side user confirmations, not ingress auth or target privileges.
- Q2=B, Q4=A, Q7=A, Q10=A, Q13=A, Q19=A: one explicit `connection` field/principal per logical Database connection, separate safe tool categories, no old read/write/admin parser compatibility; DDL direct-only; future separately approved short fail-closed maintenance is permissible.
- Q5=A and Q8=A **superseded by Q14=B**; Q11: Raindrop keeps existing cleanup names and executes immediately with no `confirm`, `dryRun` or preview tools.
- Q17=A: Raindrop existing conservative destructive selection, batch/scope limits and partial/unknown-result safeguards stay.
- Q18=A: reconnect/rediscover Raindrop tools in the **real ChatGPT** client and verify new same-name destructive semantics before declaring that Worker's release accepted.
- Q6=A, Q16=A: implement and release sequentially **IMA → Raindrop → Database → Remote Control** via separately approved manual `workflow_dispatch` releases; no automatic publisher is added.
- Q9=A, Q12=B, Q15=A: Remote Control uses its **existing** authenticated ChatGPT/Portal/VPC/Linux environment for release acceptance, read-only preflight first, separately scoped owner permission before *any* test that changes files, launches Shell or opens a tool gate.

## Proposed code-only implementation work packages

### I0 — Shared baseline (documentation/tests only)

- Record per-Worker `tools/list` contracts and actual read/write/destructive annotations before the changes; avoid recording authorization headers, database rows, local file contents or other secrets.
- Locate the currently active tool gates and confirmations. No new shared permissions service, state store, or tool role matrix.
- Prepare synthetic/isolated unit test fixtures and independent negative tests proving absent or invalid ingress credentials remain denied. Confirm existing Portal token naming and Remote Control's separately valued token are unchanged.
- Gate: contracts and offline tests runnable against a fixed source SHA. Code-only review may proceed without production access.

### I1 — IMA: remove unused tool-registration permission parameter

- Currently `apps/ima-mcp-worker/src/tools.ts` accepts `allowWrite`, and `src/index.ts` passes `true`. Remove the parameter/conditional without changing the supported create/append/import tools or upstream credentials.
- Preserve descriptive tool risk annotations and input validation; do not change binary export, Litterbox upload, Durable Object, R2 binding or authorization behavior in this work package.
- Offline acceptance: write tools remain registered, read tools remain read-only, invalid ingress fails, unit tests/typecheck/dry-run pass. No live writes in this stage.

### I2 — Raindrop: one-call destructive cleanup under existing names

- In the currently implemented cleanup tool contract, `empty_trash` and `cleanup_collections` use `confirm` as a preview/execute switch; `remove_duplicates` uses `dryRun` defaulting to true. Remove these fields and preview branches. Keep **the current names** and make calls unambiguously destructive.
- Correct tool descriptions and `readOnlyHint:false`/`destructiveHint:true` annotations; strip any stale instructions to preview and call again. Do **not** introduce new preview/execution aliases or a central permission manager.
- Preserve duplicate selection/skip rules, current supported scope, bounded batches, fail-fast paths, error and partial/unknown outcome reporting, and no blind write retry (Q17=A). Do not reinterpret other read-only search, library-audit or diagnostics tools as mutation tools.
- Test in `apps/raindrop-mcp-worker/tests/cleanup_destructive.test.ts`, `remove_duplicates.test.ts`, `tool_contract.test.ts`, security/retry tests and simulated upstream failures. Use mocks or separately authorized disposable test data only; no real account cleanup as a smoke test.
- **Breaking contract alert:** same names once previewed by default but now directly delete. A real ChatGPT connection must refresh its tool schema and show accurate destructive meaning. If old tool signatures remain cached, **release acceptance fails**; do not claim that a client prompt is guaranteed.
- Related authoritative target: [Raindrop ADR-0003](../../apps/raindrop-mcp-worker/docs/adr/0003-direct-cleanup-with-existing-tool-names.md), which supersedes ADR-0002.

### I3 — Database: single principal, retained safe tools

- Change `DATABASE_CONFIG` parser and types to one `connection` entry per logical database ID: a direct connection URL or Hyperdrive reference, with existing optional bounds. Reject old `read`/`write`/`admin` role-shaped fields with a non-secret migration error; no dual parser or guess of the preferred credential.
- Replace separate `resolveWriteConnection` / `resolveAdminConnection` credential lookups with a shared principal resolution plus operation-specific limits. Preserve distinct MCP tools for read/structured insert-update-delete/safe DDL, input validation, parameterization, max-affected rollback and query bounds.
- Remove duplicate protocol `input_required` destructive-DDL confirmation, preserving accurate `destructiveHint`. Keep Safe Admin operations direct-only for DDL; reject Hyperdrive DDL without silent direct fallback.
- Offline: `pnpm ... check` and **actual MySQL 8.4/PostgreSQL 17** integration must pass, including read-only server-grant denials, write-affected limits, direct DDL, Hyperdrive DDL refusal, old-config rejection and secret-safe error formatting.
- Configuration migration is a **future operator-controlled Cloudflare Secret change**, not a GitHub Actions variable or repository fixture with real credentials. Q19=A permits a separately approved short fail-closed interruption; no production Secret mutation or service disruption in the code stage.

### I4 — Remote Control: remove tool gates but not execution boundaries

- In `apps/remote-control-mcp-worker/src/worker.ts`, remove `REMOTE_CONTROL_ENABLE_FILE_WRITES` and `REMOTE_CONTROL_ENABLE_SHELL` checks from `tools/list` and `tools/call`, replacing gate logic with a supported-tool-name membership check and strict argument validation. Do not add execution privilege, capability aliases or unlimited Shell access outside the already curated tools.
- Keep `MCP_ACCESS_TOKEN` dedicated to Remote Control, its independent VPC/device credential, Linux OS account authority, tool schemas and accurate risk metadata, operation IDs/receipts, managed session ownership, non-replay and `invocation_logs=false` policy.
- Offline acceptance: all supported names are discoverable regardless of removed config flags, unknown names fail, incorrect tokens fail, operation receipts and session lifecycle tests pass. Verify public tool-name to Agent handler mapping and rule out unexpected legacy `start_process`/public `run_command` mismatch before claiming real-client behavior.
- **Hard release block:** Do not deploy the gate-removal code to the live Remote Control endpoint as a routine publisher change. The existing Linux login account may access user files/secrets and Shell may reach privilege pathways. T07/T09/T10 risk review (including session stop race), real ChatGPT/Portal acceptance, and the separately authorized in-place test gate are mandatory first.

## Acceptance and release workflow

1. Implement one scoped code PR at a time, merging only after independent code-review authorization; all source checks run against the reviewed SHA. PR merges never imply production deployment.
2. Before each Worker release, reconcile the live version, mandatory Cloudflare resource bindings, Secret **names**, observability policies, prior release gates, reviewed recovery path, and test coverage. Protect against other simultaneous publishers.
3. The repository's existing GitHub Actions `workflow_dispatch` is the **only** production publishing path and requires separate operator authorization for **each** selected Worker. No `push`-based publish, automatic rollback or secret copying to GitHub.
4. Confirm exact deployed version = 100%-active Cloudflare version, mandatory bindings, denied unauthenticated MCP access, and real Portal/ChatGPT initialize + `tools/list`. A generic HTTP 403 is not proof of a working authenticated client path.
5. For Raindrop, Q18=A requires genuine client re-discovery and accurate destructive descriptions/annotations; no real destructive cleanup for metadata verification. For Database, perform the independently approved `DATABASE_CONFIG` migration and short maintenance using the coordinated plan; exercise only approved safe queries. For Remote Control, require specific later owner approval **before enabling write/Shell behavior or running fixture mutations**, including a plan to restore safe gate/release state.
6. If any release acceptance gate fails, stop advancing to the next Worker; record the failure and use a reviewed **new** recovery release on the current trusted branch. Never silently roll back to a historical Cloudflare version that could restore old secrets, bindings or invocation logging.

## Remote Control in-place test authorization checklist (Q20 procedural gate)

Q20 does not require another architectural vote: **the future actual test still requires a new, explicit operator approval**. The approval request must identify:

- The current Worker and actual Linux device/user identity; active version; permission/observability state; relevant T07/T09/T10 open blockers.
- Disposable fixture path; exact bounded harmless command, expected file/process effects, allowed test tools and prohibited scope; no secret/private content in logs.
- Whether a temporary code release/feature toggle/connected-plugin modification is necessary, and why; exact duration or completion condition; how auth failure is checked.
- Prepared stop and recovery plan with current bindings/Secret names, non-secret evidence and manual-only deployment process; cleanup and final verification.
- The explicit owner decision for **this test** (not a reusable permission grant), separate from any later permanent production exposure.

Until such approval is granted and blockers are closed, only read-only preflight/research and offline tests are in scope.

## Exit gates and deferred matters

**Ready to begin code implementation:** ADRs and domain context agreed, code-only scope and offline regression strategy specified; no unknown architectural dependencies requiring another grilling round.

**Not ready for production release:** no evidence in this design branch of code implementation, CI passes for changed code, live client tool-schema refresh, final Database Secret migration, or Remote Control in-place test approval. These must be demonstrated later.

**Deliberately deferred:** adding new capabilities beyond the existing curated Worker tools, redesigning SQL to arbitrary execute, supporting Hyperdrive DDL, centralizing OAuth/tool permissions, changing underlying Linux accounts, broadening Raindrop cleanup selection, exposing production test write/Shell without separate owner authorization.

The implementation plan is not a schedule and does not presume automatic background execution.
