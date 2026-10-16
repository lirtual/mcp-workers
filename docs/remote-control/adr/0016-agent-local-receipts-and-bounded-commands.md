# ADR-0016 — Agent-local receipts and bounded development commands

**Status:** Partially accepted — first grilling round agreed 2026-10-16 (Q1=A, Q2=A, Q3=A). **Not yet implementation-approved.** Migration, timeout enforcement and failure-mode handling remain open for the next grilling round.

## Context

The Linux Agent provides an authoritative local `Operation Receipt` keyed by `operation_id` to protect state-changing operations from accidental re-execution after lost responses. On `main`, `apps/remote-control-agent/src/operations.ts` uses an atomically replaced JSON file with 30-day retention and `MAX_RECEIPTS = 1000`. Its admission path can reject all new mutations when at capacity, including a `force_terminate` request that would otherwise free resources. The live host may run a different installed Agent revision from GitHub `main`, so deployment and installed-version verification are separate work.

The newer `main` implementation of `sessions.ts` already excludes completed session history from the 10 **active** command slots and uses a session supervisor. We must preserve those fixes instead of rebuilding process ownership or adding a second execution engine. The existing system has a single Agent-side local execution boundary shared conceptually by v1 and v2 despite differing network ingress.

The owner prioritizes a minimal, reliably recoverable single-user Linux Agent, preserving existing operation IDs and Unknown Outcome behavior rather than introducing more Cloudflare resources or a complex task scheduler.

## Accepted decisions from grilling, round 1

1. **Local storage:** Replace the fixed-capacity JSON receipt store with a **single local SQLite database using the Node.js 24 built-in `node:sqlite` module**. Preserve authoritative per-`operation_id` deduplication, parameter-digest conflict detection, at-least-once outcome reconciliation, and the existing 30-day receipt retention window. No new database server, ORM, Cloudflare D1/R2, Durable Object or external storage service. SQLite is an implementation detail: it does not belong in the domain glossary.
2. **Command lifetime:** Ordinary temporary development commands have a **maximum runtime of 60 minutes**. Long-lived services belong to an existing system service manager (e.g., systemd) rather than a new lease-renewal protocol or indefinite Agent-owned command session.
3. **Shared implementation:** The Agent-local receipt store and managed-command lifecycle are shared by **both v1 and v2**. Do not duplicate storage or process-management mechanisms by transport version. Do not change the existing v1/v2 authentication, pairing, deployment routing or Worker transport in this effort.
4. **Preserved safety invariants:** No blind repeat of an `unknown` operation; no claim of exactly-once external effects; only Agent-owned processes may be stopped; local OS account permissions and current authorization checks are unchanged. SQLite disk/storage failures must not silently downgrade durability for new file writes or process starts.

## Consequences and trade-offs

- **Benefits:** Removes the fixed 1,000-entry throughput bottleneck without repeatedly rewriting an entire JSON history; requires no new infrastructure; retains transport-independent local operation semantics; prevents forgotten temporary Vite/build/test sessions from running forever.
- **Costs:** Adds a local storage migration and recovery policy; needs SQLite transaction/unique-key tests and disk-error behavior; long interactive development tasks may time out; upgrades must account for installed Agent versions rather than assuming `main` matches production.
- **Explicitly rejected for this design:** Raising `MAX_RECEIPTS` to an arbitrary larger number; silently deleting unexpired receipts when full; creating a D1/DO/R2 receipt backend; separate v1/v2 execution implementations; generic workflow/queue/scheduler frameworks; adding indefinite renewable leases in the first release.

## Open frontier — NOT yet decided

- **Q4:** One-time migration from existing JSON receipts: preservation/backup, validation, and fail-closed startup when migration cannot complete.
- **Q5:** Exact time-limit enforcement against the Agent-owned process/supervisor, including graceful escalation and observable timeout outcome.
- **Q6:** Authenticated Agent-owned session termination when receipt persistence or local disk becomes unavailable. Any exceptional path must not silently assert a durable receipt or permit unrelated process control.

No DDL, schema choices, operational repair commands or acceptance thresholds for these open questions are authorized by this document. Capture decisions in a subsequent update before `to-spec`/`to-tickets` and implementation.

## Authority and rollout

This is a **documentation-only, in-progress architectural record**. It does **not** authorize production restarts, changing credentials, backup deletion, deploying a new Agent/Worker, merging code, or resolving the existing host outage. Implementation and any production cutover require their own validation and explicit approval.

Related: [Remote Control context](../CONTEXT.md), v1 [spec](../SPEC.md), ADR-0007 (receipts), ADR-0009 (managed sessions), ADR-0013 (native Agent), and prospective v2 spec Issue #46.
