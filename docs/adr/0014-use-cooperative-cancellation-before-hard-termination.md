# ADR 0014: Use cooperative cancellation before hard termination

- Original status: Accepted
- v0.1 disposition: SIMPLIFY
- v0.1 authority: `docs/workflow-mcp/v0.1-architecture-reduction.md`
- Date: 2026-09-17

## Context

Workflow work may be executing in multiple backends when a user cancels a run or a timeout expires. Abrupt termination can leave external executors running, while pretending cancellation implies rollback would be incorrect for irreversible side effects such as sent messages, published content, deleted files, or committed writes.

## Decision

Cancellation is a durable two-stage stop process.

When cancellation is requested, the Workflow Run records `cancel_requested`, stops admitting new Step Runs, and asks active Executors to cancel their current work. After a bounded grace policy, remaining execution may be hard-terminated.

Cancellation does not mean rollback or compensation. Completed side effects remain completed unless the Workflow Definition explicitly modeled compensating work.

v0.1 supports explicit Workflow-level and Step-level timeouts. Workflow timeout has no finite default because valid workflows may intentionally wait for long periods. A timeout follows the same stop path as cancellation but ends in `timed_out` instead of `cancelled`.

Generic Saga/compensation semantics are outside v0.1.

## Consequences

### Positive

- External executors get a chance to stop cleanly.
- New work does not start after cancellation intent is durable.
- Workflow state accurately distinguishes user cancellation from timeout.
- The system does not promise impossible rollback behavior.

### Negative

- Cancellation is not instantaneous.
- Executor adapters must implement best-effort cancellation where their backend supports it.
- Some remote work may finish after cancellation was requested.
- Users must model compensation explicitly when business semantics require it.

## Rejected alternatives

- Hard terminate immediately: simple but can orphan remote work and lose useful cleanup opportunities.
- Treat cancellation as rollback: misleading and impossible for many external side effects.
- Give every workflow a fixed default timeout: breaks legitimate long-waiting workflows.
