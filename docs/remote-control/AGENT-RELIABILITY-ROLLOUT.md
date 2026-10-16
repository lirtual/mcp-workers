# Remote Control Agent reliability — acceptance and rollout gates

**Status:** Agent implementation verification plan for [Spec #60](https://github.com/lirtual/mcp-workers/issues/60) and tickets #61–#65. This document is **not** authorization to restart a live Agent, touch device credentials, migrate real receipts, stop a live process, merge, or deploy.

## Scope and boundaries

The common Linux/WSL Agent is the sole target. v1/v2 keep their existing ingress, credential, permission, tool-name and operation-ID contracts. There is no new Cloudflare service, remote database, ORM, CI workflow, public endpoint or process controller.

Node.js **24** built-in SQLite stores local operation receipts in a private state directory. Normal terminal/no-effect records can expire after **30 days from original admission**. Unknown and any possibly effectful failed operations must remain protected beyond that period; nonzero exit is not proof of no side effects. Idempotent replay returns a known result or unknown without re-execution, and a changed digest conflicts. No external exactly-once guarantee.

Ordinary temporary Shell commands have an **absolute 60-minute lifetime from actual process start**, independent of the client's initial request wait (at most 30 seconds). The existing Agent-owned, pidfd-verified Session Supervisor sends SIGTERM, waits at most **five seconds**, and sends SIGKILL if necessary. A termination that cannot be confirmed remains unknown; no arbitrary-PID control.

## Offline tests before any live-host change

1. Pin the implementation revision, ADR-0016, Spec #60 and current Agent version. Check Node 24 supports built-in SQLite. Use disposable files and an **isolated** Agent state directory, never the connected device's live state.
2. Create owner-private fixture backups containing the known original 1,000 receipts and reduced 300 current receipts. The historical file's **exact known basename** is operation-receipts.backup-20261016-090053.json. For this historically trimmed Agent, set the local Agent process environment variable **REMOTE_CONTROL_RECEIPT_HISTORICAL_BACKUP** to the verified absolute file path *before* any authorized first upgrade. If it is missing, migration fails closed. This is an operator-only local upgrade setting, not a Worker or MCP input, and does not apply to an unrelated device that happens to have 300 legitimate receipts. Explicitly verify the original backup belongs to the Agent/revision. No arbitrary backup scanning or importing. If the live owner or required historical backup cannot be verified, **do not perform a live cutover**.
3. Through existing authenticated localhost HTTP/tool tests, verify 1,500 admissions, same-ID duplicate and changed-intent conflict, a 31-day old unknown replay guard, a nonzero-exit command with a prior file side effect, malformed/conflicting import, crash and restart, two Agents contending for one state path, and an independent second Agent directory.
4. Verify SQLite full/read-only/corrupt/commit failure rejects all new mutations, commands and stdin input, without losing read-only file and session visibility. The only degraded mutation exception is an **authenticated stop of a currently verified Agent-owned session**, with an unknown response if persistence cannot attest success.
5. Verify an idle temporary process expires at its absolute deadline, SIGTERM precedes SIGKILL by at most five seconds, no unrelated process is signaled, and session capacity frees only after confirmed termination. The existing 10 active/starting session limit and bounded output history must not regress.
6. Run existing Agent typechecks, tests and CI. Record sanitized test IDs AT01–AT12, run IDs, revisions and counts only; do not emit raw receipts, command data, private paths, credentials or environment values.

## Installation gate (separate explicit owner authorization required)

Confirm installed Node and Agent revision, state path, actual one-owner status, original current JSON, preserved historical backup and private checksum/backup **before stopping** the old Agent. Rehearse a full migration on copied state first. When explicitly authorized, stop the old instance through its known host service management, prevent competing writers, then start the reviewed Agent once. Confirm protected legacy IDs, new synthetic mutation, read operations, managed sessions, output and safe shutdown. Do not infer production readiness from CI passing or a successful GitHub merge.

After a successful migration the SQLite database is authoritative. Preserve the original JSON source, restricted pre-SQLite backup and historical snapshot; no silent JSON fallback, automatic downgrade, or dual-writing.

## Deliberate manual rollback only

Stop the new Agent first and privately back up its SQLite state and journal files. Check all **post-migration** protected IDs, admissions and unresolved effects before recovering an older JSON-only version. Merely replacing the database with an old JSON file would lose post-upgrade operation identities and could cause duplicate effects. If reconciliation cannot be demonstrated, keep the old version stopped and repair explicitly; never authorize blind retry based on age or process exit code.

**Non-goals:** real-host migration or restart during PR work; new CI pipelines; OS service migration, Cloudflare configuration, permission or secret changes; automatic replay, privileged process control or generic recovery framework.
