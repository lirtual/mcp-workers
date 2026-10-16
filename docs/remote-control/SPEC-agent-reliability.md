# Remote Control Agent — Local Reliability Technical Specification

> **Status:** Draft / ready for design review, **not approved for implementation or rollout**.
> **Baseline:** GitHub `main` checked 2026-10-16. Architecture decisions Q1–Q9 from [ADR-0016](./adr/0016-agent-local-receipts-and-bounded-commands.md), reviewed against [CONTEXT](./CONTEXT.md), existing [v1 Spec](./SPEC.md) and current Agent source.
> **Scope:** The local Linux Agent receipt lifecycle, temporary managed processes and safe recovery shared across Remote Control v1/v2; no change to their transport or authorization policy.

## 1. Problem and outcome

The current local JSON receipt store has a 1,000-entry hard limit. At capacity, admission for new state-changing operations — including `force_terminate` — can return `unavailable` even though authenticated file reads and session listing still work. A host can also accumulate 10 long-running temporary Vite/build processes and exhaust active command slots. Independently, an interrupted/failed operation may have produced side effects and must not become automatically replayable just because a retention period elapsed.

**Required result:** A single-user, local-only Agent remains operable without routine manual receipt trimming; durable writes and process starts are guarded by stable `operation_id`; eligible receipts expire without losing unresolved effect protection; temporary commands terminate after at most 60 minutes plus bounded 5-second escalation; an authenticated caller can stop a currently Agent-owned process even if the receipt database is unavailable.

Success is measured at the **existing loopback Agent HTTP/tool boundary**, not by direct testing of internal SQLite helpers.

## 2. User stories

1. **US01:** As the device owner, I want an Agent that can accept thousands of ordinary state-changing requests over time, so that receipt capacity does not repeatedly disable development.
2. **US02:** As a remote caller, I want resubmitting the same operation identity and same arguments to return the known outcome without rerunning the effect, so that network retries are safe within the protected window.
3. **US03:** As a remote caller, I want a reused operation identity with different arguments to be rejected, so that the Agent cannot confuse two intentions.
4. **US04:** As the device owner, I want existing JSON receipts and their known historical backup protected during first startup, so that an upgrade does not erase retry protection.
5. **US05:** As the device owner, I want incomplete or inconsistent receipt migration to fail safely, so that an apparently clean database cannot authorize duplicate operations.
6. **US06:** As a remote caller, I want an unconfirmed prior operation to remain non-replayable beyond normal retention, so that age alone never implies the operation had no effect.
7. **US07:** As the device owner, I want normal completed and provably no-effect failed receipts automatically retired after 30 days, so that the local store remains bounded by actual activity.
8. **US08:** As a remote caller, I want state-changing operations to be rejected when durable storage cannot record them, so that a storage fault does not silently defeat deduplication.
9. **US09:** As an authorized remote caller, I want to stop an existing Agent-owned session when the receipt database is unavailable, so that a resource incident cannot prevent safe cleanup.
10. **US10:** As the device owner, I want temporary commands to terminate at the 60-minute limit, so that forgotten development servers do not exhaust all command slots.
11. **US11:** As a remote caller, I want timeout, normal exit, failed execution and uncertain effect reported distinctly, so that I do not mistake an exit code for a guarantee of no side effects.
12. **US12:** As a device operator, I want crashes/restarts to preserve uncertain operation identities and not leave unmanaged Agent child processes, so that recovery does not cause blind retries or orphaned sessions.
13. **US13:** As a device operator, I want v1 and v2 to reuse the same local Agent behavior without sharing state accidentally between distinct Agent instances, so that upgrades do not introduce conflicting writers.
14. **US14:** As a device operator, I want a one-way upgrade with a preserved source backup and deliberate rollback runbook, so that reversing an installed version cannot silently forget post-upgrade operations.
15. **US15:** As the device owner, I want authentication and existing safe read operations to remain unchanged, so that reliability work does not expand remote host privileges or break routine diagnostics.

## 3. Invariants and scope boundaries

- Existing Portal Bearer/device-credential checks remain mandatory for every request, including emergency stop; never expose stop through an unauthenticated route, even on loopback.
- Existing user-account privileges and the Session Supervisor's verified process-group ownership remain authoritative. Never stop a foreign host process or permit arbitrary PID input. The owning session must currently exist in the Agent's own session registry and be validated by the existing supervisor control path.
- `operation_id` plus canonical argument digest identifies one operation intent. `same` never repeats an effect, `conflict` never executes. Unknown outcome is **not** equivalent to failure/no-effect. No exactly-once guarantee for external side effects.
- Normal terminal receipts have a 30-day protection window from the original admission timestamp; unresolved effects remain guarded beyond it. The retention policy applies equally after migration and restart, not only to records created in SQLite.
- **Execution outcome vs. effect certainty:** a Shell exit code `!= 0` can mean the command executed writes before failing. Persist/reconcile such operations conservatively; neither `failed` nor `completed` alone is proof of no side effects. A no-replay guard is only eligible to expire when prior effects are known/protected under the normal contract; do not treat process exit failure as safely retryable. Reconciliation, not elapsed time, clears a still-uncertain guard.
- A process start or file mutation is admitted durably **before** beginning its effects. If durable admission fails, do not start execution. After an effect begins, a failed final receipt update must leave a retriable reconciliation record or result in `unknown`, not imply no work occurred.
- An emergency stop is an exception only to *persistence admission*, never authentication or process ownership, and never allows new commands, process input or filesystem mutation.
- No new public RPC, MCP tools, D1/R2/DO binding, login mode, queue, scheduler, service manager, ORM or extra CI workflow.

## 4. Implementation seams / file responsibilities

| Existing location | Smallest permitted change |
|---|---|
| `apps/remote-control-agent/src/operations.ts` | Replace JSON internals of `ReceiptStore` with `node:sqlite`, preserving existing `admit / update / get / close` contract and `operationDigest`. Implement transactional identity/guard rules, expiration, first-run import and fault handling internally. |
| `apps/remote-control-agent/src/sessions.ts` | Extend existing `ManagedSessions` / Session Supervisor for per-session absolute runtime deadline and 5-second termination escalation. Keep active-session ceiling 10 and current bounded output/history behavior. |
| `apps/remote-control-agent/src/server.ts` | Adapt current loopback handler to distinguish durable admission failure, effect uncertainty and authenticated emergency `force_terminate`; continue using existing operation/session endpoints, device checks and in-flight tracking. |
| `apps/remote-control-agent/scripts/session-supervisor.c` | Reuse existing pidfd-owned process-group signaling; change only if timing tests demonstrate a required compatibility fix. |
| Existing Agent tests under `apps/remote-control-agent/tests/*.test.ts` | Add public-boundary behavior tests using existing `node --test` and test Agent startup hooks; reuse existing CI, no new pipeline by default. |
| `docs/remote-control/` | Document installation, upgrade, one-time backup inspection, degraded-mode behavior and safe rollback runbook; no secret values in logs. |

**Interface compatibility:** Keep accepted request tool names (`start_process`, `force_terminate`, `interact_with_process`, `list_sessions`, `read_process_output`), `operation_id`, argument syntax and response shapes. Existing `timeout_ms` remains the caller's **initial wait** (up to 30 seconds), **not** a way to extend or override the separate 60-minute process lifetime. No client-managed leases.

## 5. Local SQLite model and durability

Use one single SQLite database file in the existing per-Agent private state directory. Node.js 24's built-in `node:sqlite` is the only database dependency; check runtime capability before cutover. Open under a **single owning Agent process**, use a private directory (0700) and file permissions (0600), SQLite atomic transactions, primary-key uniqueness and durable commit before execution. Keep synchronous database work small and do not wrap a running Shell command in a database transaction.

One receipt table is sufficient. Persist at minimum:
- `operation_id` unique/primary key; `tool_name`; canonical `argument_digest`;
- current `state` (`admitted | running | completed | failed | unknown`), original `created_at` and last `updated_at`;
- optional bounded `safe_result_summary`, `session_id` while meaningful, and a **small replay-protection/effect-certainty flag** separate from the process exit status so `failed` with uncertain side effects cannot become eligible for deletion;
- a database schema version using built-in SQLite schema metadata (`PRAGMA user_version` or equivalent), **not** a new service or generalized migration framework.

A protected long-lived marker can be the **same receipt row**, stripped to `operation_id`, tool identity, argument digest and the minimum `unknown / protected` identity metadata. **No second tombstone service or table required.** Do not retain raw commands, file payloads, personal paths, secret values or full process output for deduplication.

The implementation must check idempotency under one serialized/transactional admission path. If the same ID/digest already exists, return existing status without executing; different digest/tool yields conflict. If the prior result is unresolved or guarded, querying returns uncertainty and executing it again under that ID is forbidden. A consciously new operation uses a new ID and normal authorization; it is not described as replay of the unknown one.

Cleanup runs at safe bounded Agent housekeeping opportunities (initialization and routine admission/maintenance), **not a background scheduler**. Delete only eligible terminal records whose original created-at is more than 30 days old and whose replay guard is cleared. Compact the summary for protected unresolved records after normal retention; do not automatically purge them. SQLite write failures (disk full, corruption, permission errors, commit errors) cause explicit `unavailable` / fail-closed admission. Do not drop still-protected identities to hit a record-count or byte quota, silently recreate an empty DB, or treat a DB write failure as permission to execute.

## 6. One-time JSON → SQLite migration

Perform only when no completed SQLite migration is present. Acquire a single-writer ownership guard **before** touching either receipt source or target, and prevent concurrent v1/v2 Agent instances with the same state path from migrating or writing simultaneously. Shared source code does **not** imply shared storage across independent devices/Agent instances; use instance-owned state and refuse conflicting concurrent owners. Do not add a distributed lock.

Migration preflight:
1. Identify the current `operation-receipts.json` and the **known, operator-preserved historical backup** from the earlier 1,000→300 receipt cleanup. The backup source must be explicitly verified as belonging to this Agent and revision; do **not** glob/import arbitrary JSON files from a directory.
2. Retain the original JSON files unchanged, save/verify a restricted-permission migration backup, and validate file schema/version, timestamps, normalized state/tool, digest, and unique ID.
3. Reconcile the known backup against the current JSON: preserve current authoritative records, supplement any still-protected history missing from the truncated live store, and fail closed on same-ID conflicting tool/digest/state that cannot be reliably resolved. Record **counts and redacted reasons**, not operation details.
4. Convert interrupted `admitted/running` state conservatively to `unknown`; treat historical `failed` records with no proof of no-effect (especially a spawned command) as guarded rather than quietly deleting after expiry. Expired definitely terminal/no-effect records need not be imported.
5. Import and verify in a single SQLite transaction. Publish/mark the database migrated only after counts and identities/digests/states/guards have been validated. An interrupted migration can resume idempotently or stop for operator repair; **never initialize an empty valid DB while prior records exist**.
6. Successful migration retains JSON backup as read-only operator recovery material. Subsequent starts use SQLite only; do not dual-write, auto-downgrade or overwrite the backup.

**No legacy store:** On a genuinely fresh private directory with no known prior receipts, initialize the SQLite schema normally. If a historical state path is present but unreadable, migration **fails closed** rather than classifying it as fresh.

**Rollback:** If an older Agent must be restored, stop the current Agent, inspect post-migration SQLite operations and protected identities, and require an operator-approved reconciliation/recovery procedure. Restoring old JSON alone is **not** a safe rollback.

## 7. Bounded process lifetime and control-plane recovery

Reuse existing Linux Session Supervisor, pidfd process-group ownership checks and active-session capacity. Each successfully spawned **ordinary** managed command acquires an absolute deadline at **60 minutes from actual process start**. This is independent of MCP request lifetime, 30-second initial wait, last-read time and terminal history TTL.

At deadline:
1. Signal `SIGTERM` to **only** the verified Agent-owned process group.
2. Wait at most **5 seconds** for the owned process/supervisor to exit.
3. If still alive, send `SIGKILL` through the same supervisor-owned signaling path, then confirm/observe the result; record timeout reason using the existing receipt/result contract.
4. If the process cannot be confirmed stopped, surface `unknown` and keep non-replay protection; never claim a timeout guarantees process effects were rolled back. An uninterruptible kernel process may survive the nominal deadline.

Expiration must run while the Agent is idle: implement an Agent-local deadline/timer integrated with `ManagedSessions`; do not rely on polling, read output, a Client request or a separate cron. Clean timers when the session ends or Agent closes. Keep the existing **10 active/starting sessions** limit; completed history must not consume slots. Do not forcibly reclaim a legitimately active process before its deadline solely to admit a new one.

When SQLite is unavailable:
- Authenticated `list_sessions` / `read_process_output` and safe read-only file inspection remain available where independent of SQLite.
- Reject all new state-changing file operations, `start_process`, and `interact_with_process` (stdin write) without attempting side effects.
- Permit **only** authenticated `force_terminate` of a currently verified Agent-owned session, bypassing failed receipt admission. Repeated requests are safe only if the session is still owned or already conclusively stopped; do not infer outcome from a missing historical receipt.
- If the stop cannot be recorded durably, return an **honest `unknown`/degraded result** via the existing response envelope while preserving a safe high-level diagnostic event without raw command content. Do not fabricate a receipt or assert durable success.
- Do not send signals by arbitrary numeric PID, create another admin stop endpoint, or bypass device authentication.

## 8. Crash, retry, version and trust boundaries

- After restart, resolve interrupted receipt states to `unknown` unless independently provable no-effect. Do not blindly replay `admitted` or `running` operations. Existing supervisor closes/kills on Agent control disconnect; verify this in real integration tests rather than assuming it always succeeds.
- If disk failure occurs **after** an effect but **before** final persistence, return uncertainty; once storage is restored, reconcile rather than re-run.
- `failed` is **execution status**; it is not sufficient evidence of absence of file writes or process side effects. Preserve a replay guard for side-effect-possible failures, including nonzero-exit Shell sessions, and expose the command's failure reason separately through existing bounded/safe summaries. No new public failure-status enumeration is required.
- Existing credentials remain separate across v1/v2 ingress; the Agent controls its local data directory. Distinct Agent instances must not share the database concurrently; do not add distributed state synchronization.
- Existing schema, operation identity, digest conflicts, error envelopes, logs with safe event names, and local OS permission boundary remain stable unless the Spec explicitly identifies the narrow compatibility adjustment.
- The installed Linux host's actual Node/Agent versions and startup mode are verified before cutover. Do not infer live host version from GitHub `main`.

## 9. Test plan and acceptance criteria

Use the existing Agent test runner and authenticated localhost HTTP/tool calls. Avoid direct SQL-only assertions as primary acceptance. Tests may inject isolated state directories or launch test Agent instances through existing public seams, but must not require a new production API.

| ID | Observable acceptance |
|---|---|
| AT01 | More than **1,000** unique admitted operations (e.g. 1,500) succeed in one owned store without the old count-capacity response; matching replay does not execute again and changed digest is rejected. |
| AT02 | Crash/reconnect/restart with an interrupted operation returns `unknown` and never re-runs it; the same ID/digest cannot re-execute while guarded, including after 30 days (clock-controlled). |
| AT03 | Normal terminal/no-effect receipts expire only after 30 days. A nonzero-exit command that already modified a fixture file cannot be misclassified as guaranteed no-effect/automatically replayable. |
| AT04 | An original 1,000-entry JSON snapshot plus a reduced 300-entry current file migrates without losing protected IDs; conflicting same-ID records, malformed JSON, unreadable backup, duplicate IDs and aborted transactions fail closed with source preserved. |
| AT05 | Two Agent instances pointed at one local state path cannot both write; separate state directories can operate independently and follow the same local behavior. |
| AT06 | SQLite full, corrupt, read-only or write-commit failure rejects new mutation/start/input while safe reads and authenticated list sessions remain accessible. |
| AT07 | With receipt persistence unavailable and ten active sessions, an authorized request can stop one verified Agent-owned process, then capacity is freed; an unauthenticated or foreign-process request cannot terminate anything. Result is `unknown` if durable acknowledgement is impossible. |
| AT08 | Long-lived command receives SIGTERM at 60-minute deadline and SIGKILL after at most 5-second grace, freeing the session slot; a command exiting normally earlier is not signaled, and no unrelated PID is affected. Test with a controllable clock or suitably shortened **test-only** timeout without changing the production 60-minute boundary. |
| AT09 | `timeout_ms` continues to limit initial wait to at most 30 seconds; it neither changes the absolute command lifetime nor requires the client to poll to trigger stopping. |
| AT10 | After a timeout or nonzero exit following a file side effect, existing read/operation-result semantics distinguish execution outcome from certainty; no false durable success and no blind operation replay. |
| AT11 | Bad credential, malformed operation ID, unauthorized stop and unknown session retain the existing auth/error behavior. No new MCP tools, Worker credentials or broad process-control permission are introduced. |
| AT12 | Upgrade, safe first migration, second startup and operator rollback exercise the documented runbook with source backup preserved, installed version verified, and **no automatic old-version JSON dual-write**. |

**Definition of Done:** All applicable existing Agent tests/typechecks + these behaviors pass, using current CI wherever present. No new CI pipeline by default. Run non-production isolated migration/fault tests first; stage installation of the Agent with explicit operator approval. Confirm v1 and v2 caller paths continue to use the same Agent implementation, with no change to their Cloudflare deployments. Observe receipt volume, unresolved marker count and active sessions through existing safe logs/diagnostics (no telemetry backend).

## 10. Explicitly out of scope

No multi-device synchronized receipt database; no remote SQLite/D1/R2/DO; no ORM, Redis, queue, lease protocol, workflow scheduler, extra cleanup daemon, generic migration framework, external watchdog, public admin/reconciliation API, new authentication flow, arbitrary process kill, operation auto-replay, automatic old-Agent rollback, long-term JSON/SQLite dual-write, or changes to the application's unrelated Workers.

Do not change user-configured Shell/file-write permission decisions or existing v1/v2 Worker ingress and pairing. Do not add CI when the existing workflow suffices. Do not update Cloudflare production, restart the live Agent, delete/rotate historical receipts or perform a production cutover as a consequence of writing this document.

## 11. Delivery stages and authorization

1. **Spec review:** Check this document against ADR-0016 and existing public endpoints; seek explicit user approval for implementation design. This draft itself grants no write/deploy permission.
2. **To Tickets (only on request):** Group work into the minimum independently testable steps: receipt durability/migration; emergency-control recovery; bounded sessions; final integrated acceptance. Reuse existing CI and related Issues/PRs.
3. **Implementation (separately authorized):** Use isolated branch and existing tests. Validate against a copied fixture with the real historical backup before applying any migration to a live host.
4. **Rollout (separately authorized):** Verify installed Node/Agent revision, stop old Agent through an approved maintenance window, take a verified backup, migrate and exercise read, write, start/stop, crash recovery. Do not infer successful deployment from GitHub merge.

**Design trace:** [ADR-0016](./adr/0016-agent-local-receipts-and-bounded-commands.md), Q1–Q9; 2026-10-16 final deep audit added historical backup completeness, failed-but-effectful operations, per-instance state ownership and actual deadline enforcement.
