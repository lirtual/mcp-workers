# ADR 0020: Map one GitHub execution to one Step Attempt

- Original status: Accepted
- v0.1 disposition: SIMPLIFY
- v0.1 authority: `docs/workflow-mcp/v0.1-architecture-reduction.md`
- Date: 2026-09-17

## Context

GitHub-hosted execution has startup overhead, so batching several adjacent workflow steps into one job would reduce latency and runner minutes. However, retries, cancellation, timeouts, operation IDs, logs, credentials, and result correlation are all defined at Step Attempt granularity.

If one job executes several steps, orchestration must recreate sub-step state inside the runner and weakens the boundary between durable workflow state and temporary compute.

## Decision

In v0.1, one GitHub Execution Request performs exactly one Step Attempt.

A generic GitHub runner receives only an Execution Request identifier, authenticates to the workflow service, obtains an execution-scoped Credential Lease and Execution Manifest, performs the single authorized Capability attempt, uploads any resulting Artifacts, and returns one normalized Execution Result.

Batching adjacent GitHub steps is deferred as a future transparent optimization and must not change Workflow Definition semantics if introduced.

## Consequences

### Positive

- Retry, cancel, timeout, logs, and correlation align with the same execution boundary.
- GitHub remains a compute executor rather than a second workflow engine.
- Failure recovery can redispatch exactly one Step Attempt.
- Credentials can be scoped to one attempt.

### Negative

- Multiple adjacent GitHub steps incur additional runner startup latency and Actions consumption.
- High-throughput workloads may later need execution batching optimization.

## Rejected alternatives

- Execute an entire workflow inside one GitHub job: collapses orchestration and execution layers.
- Batch arbitrary consecutive GitHub steps in v0.1: premature optimization before execution semantics are proven.
