# ADR-0016 — Agent-local receipts and bounded development commands

**Status:** Partially accepted — grilling rounds 1 and 2 agreed 2026-10-16 (Q1–Q6=A). **Not yet implementation-approved.** Receipt expiry, disk-capacity behavior and upgrade/rollback boundaries remain under review.

## Context

The Linux Agent provides an authoritative local `Operation Receipt` keyed by `operation_id` to protect state-changing operations from accidental re-execution after lost responses. On `main`, `apps/remote-control-agent/src/operations.ts` uses an atomically replaced JSON file with 30-day retention and `MAX_RECEIPTS = 1000`. Its admission path can reject all new mutations when at capacity, including a `force_terminate` request that would otherwise free resources. The live host may run a different installed Agent revision from GitHub `main`, so deployment and installed-version verification are separate work.

The newer `main` implementation of `sessions.ts` already excludes completed session history from the 10 **active** command slots and uses a session supervisor. We must preserve those fixes instead of rebuilding process ownership or adding a second execution engine. The existing system has a single Agent-side local execution boundary shared conceptually by v1 and v2 despite differing network ingress.

The owner prioritizes a minimal, reliably recoverable single-user Linux Agent, preserving existing operation IDs and Unknown Outcome behavior rather than introducing more Cloudflare resources or a complex task scheduler.

## Accepted decisions from grilling, round 1

1. **Local storage:** Replace the fixed-capacity JSON receipt store with a **single local SQLite database using the Node.js 24 built-in `node:sqlite` module**. Preserve authoritative per-`operation_id` deduplication, parameter-digest conflict detection, at-least-once outcome reconciliation, and the existing 30-day receipt retention window. No new database server, ORM, Cloudflare D1/R2, Durable Object or external storage service. SQLite is an implementation detail: it does not belong in the domain glossary.
2. **Command lifetime:** Ordinary temporary development commands have a **maximum runtime of 60 minutes**. Long-lived services belong to an existing system service manager (e.g., systemd) rather than a new lease-renewal protocol or indefinite Agent-owned command session.
3. **Shared implementation:** The Agent-local receipt store and managed-command lifecycle are shared by **both v1 and v2**. Do not duplicate storage or process-management mechanisms by transport version. Do not change the existing v1/v2 authentication, pairing, deployment routing or Worker transport in this effort.
4. **Preserved safety invariants:** No blind repeat of an `unknown` operation; no claim of exactly-once external effects; only Agent-owned processes may be stopped; local OS account permissions and current authorization checks are unchanged. SQLite disk/storage failures must not silently downgrade durability for new file writes or process starts.

## Accepted decisions from grilling, round 2

5. **Q4=A — One-time automatic migration:** On the first Agent startup with the new implementation, back up the existing JSON receipt file before migration. Allow **only one Agent instance / writer** to perform the transition; import historical receipts transactionally into SQLite, validate record counts and identities/states/digests, and permit new state-changing operations only once validation succeeds. If a backup, import or validation step fails, **fail closed for all new mutations and process starts**, leave the original JSON untouched and do not silently initialize an empty store or fall back to the old JSON writer. Preserve the backup for deliberate recovery; do not delete it automatically as part of a successful migration.
6. **Q5=A — Absolute command lifetime with graceful escalation:** Every ordinary Agent-owned development command has an **absolute maximum of 60 minutes measured from its actual process start**, independent of the MCP request timeout or output polling. At expiry, request `SIGTERM`, wait up to **5 seconds**, then request `SIGKILL` if the owned process remains alive. Reuse the existing supervisor and verified process ownership; never signal unrelated host processes. Record a distinct timeout reason where durable storage is available; if the effect cannot be established, report `unknown`, not success. Do not add renewable leases or another scheduling service.
7. **Q6=A — Emergency stop while persistence is unavailable:** Continue requiring existing caller/device authorization and validated Agent session ownership. When SQLite storage is full, read-only, corrupt or otherwise unavailable, block all **new** state-changing file operations and process starts, while still permitting an owner-scoped stop of an already running **Agent-owned** session. Do not expand this exception to arbitrary Shell commands, file writes, process input or unrelated system processes. If the operation result cannot be stored, report outcome uncertainty without claiming a durable receipt; recovery must not blindly repeat unknown operations.

**Safety interpretation:** This is a narrow emergency control-plane exception, not a general receipt-free mutation fallback. Exact error/result semantics and storage-failure test fixtures belong in the future technical spec; no code changes are authorized yet.

## Consequences and trade-offs

- **Benefits:** Removes the fixed 1,000-entry throughput bottleneck without repeatedly rewriting an entire JSON history; requires no new infrastructure; retains transport-independent local operation semantics; prevents forgotten temporary Vite/build/test sessions from running forever.
- **Costs:** One-time backup/transactional migration must be tested on valid, invalid and full JSON stores; an unusable SQLite store may temporarily block new mutations pending repair; long-running development processes will be stopped after 60 minutes (plus the 5-second grace period); installed Agent versions must be checked rather than assuming `main` matches production.
- **Explicitly rejected for this design:** Raising `MAX_RECEIPTS` to an arbitrary larger number; silently deleting unexpired receipts when full; creating a D1/DO/R2 receipt backend; separate v1/v2 execution implementations; generic workflow/queue/scheduler frameworks; adding indefinite renewable leases in the first release.

## Open frontier — NOT yet decided

- **Q7:** What happens to expired `unknown` receipts after the 30-day reconciliation window: retain a minimal non-replay tombstone, or expire them like completed/failed operations? This affects long-term disk growth and retry safety.
- **Q8:** How should finite local disk capacity be handled without restoring a fixed count-based outage (e.g., bounded cleanup of expired terminal receipts, refusal of new mutations on write failure, no eviction of live deduplication records)?
- **Q9:** After a successful one-way migration, should rollback of the installed Agent be restricted to an explicit, operator-verified restore/reconciliation procedure rather than introducing dual-write or automatic backward compatibility? Also distinguish this development decision from an authorized production cutover.

No schema/DDL, new administration endpoints, production repair commands or deployment authorization are implied. Finalize only material trade-offs in the next grilling round, then seek explicit final design confirmation before `to-spec`/`to-tickets`.

## Authority and rollout

This is a **documentation-only, in-progress architectural record**. It does **not** authorize production restarts, changing credentials, backup deletion, deploying a new Agent/Worker, merging code, or resolving the existing host outage. Implementation and any production cutover require their own validation and explicit approval.

Related: [Remote Control context](../CONTEXT.md), v1 [spec](../SPEC.md), ADR-0007 (receipts), ADR-0009 (managed sessions), ADR-0013 (native Agent), and prospective v2 spec Issue #46.
