# ADR 0013: Make workflow concurrency explicit and queueable

- Original status: Accepted
- v0.1 disposition: DEFER
- v0.1 authority: `docs/workflow-mcp/v0.1-architecture-reduction.md`
- Date: 2026-09-17

## Context

Some workflows are naturally safe to run concurrently, while others such as backups, imports, or synchronization jobs must serialize access to a shared target. Executor/platform concurrency limits are capacity constraints and must not silently define workflow business semantics.

## Decision

`parallel` is the default Workflow concurrency policy.

A Workflow Definition may explicitly opt into queued execution with a fixed concurrency limit. v0.1 must support the important serialized case `mode: queue` with `limit: 1`.

Runs that exceed the configured concurrency limit remain queued until capacity becomes available; they are not silently dropped and do not cancel an older run.

v0.1 does not implement replacement of active runs, drop-new behavior, or expression-derived dynamic concurrency keys. The schema may reserve a concurrency scope/key field so those policies can be added later without redefining existing semantics.

## Consequences

### Positive

- Normal independent workloads retain simple parallel behavior.
- Workflows that require serialization can state that requirement explicitly.
- Platform capacity and workflow semantics stay separate.
- Queued admission preserves work instead of silently discarding it.

### Negative

- The orchestration layer must manage queue fairness and release capacity reliably.
- Long-running serialized workflows may create backlog.
- More sophisticated per-account or per-resource concurrency remains a later feature.

## Rejected alternatives

- Serialize every workflow by default: unnecessarily reduces throughput and makes independent jobs wait.
- Let the executor's concurrency limits define behavior: couples business semantics to an implementation backend.
- Implement replace/drop/dynamic-key modes in v0.1: expands state and cancellation complexity before concrete use cases require it.
