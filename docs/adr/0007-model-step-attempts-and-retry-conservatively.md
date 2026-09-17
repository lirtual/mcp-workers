# ADR 0007: Model step attempts explicitly and retry conservatively

- Status: Accepted
- Date: 2026-09-17

## Context

A workflow engine may retry failed work, but not every operation is safe to repeat. Reads and explicitly idempotent writes can often be retried; side-effecting operations such as publishing, deleting, sending messages, or arbitrary code may duplicate effects if retried without a stable logical identity.

Treating every retry as a new Step Run loses the distinction between one logical operation and multiple physical attempts.

## Decision

A Step Run is the logical execution of one Step in one Workflow Run. Each physical execution is a Step Attempt. Retries create additional Step Attempts under the same Step Run.

Every logical side-effecting operation receives a stable Operation ID. All retry attempts of the same logical operation reuse that Operation ID. Capability adapters should propagate it to downstream idempotency mechanisms when available.

Retry policy is capability-aware. A capability may declare that its operation class is retry-safe. Retry-safe capabilities may receive a bounded retry policy by default. Capabilities that are not explicitly retry-safe default to one attempt. Workflow authors may explicitly override the retry policy when they knowingly accept the semantics.

The workflow layer owns retry semantics rather than inheriting executor-specific implicit defaults.

## Consequences

### Positive

- Run history can distinguish a logical step from its physical attempts.
- Side effects have a stable identity that downstream idempotency mechanisms can use.
- Executor changes do not silently change retry behavior.
- Unsafe operations do not become multi-execution operations merely because a backend has automatic retries.

### Negative

- Capability metadata must classify retry safety accurately.
- Some adapters require explicit idempotency support or documentation when downstream services cannot honor Operation IDs.
- Attempt-level logs and state add model complexity.

## Rejected alternatives

- Treat every attempt as a separate Step Run: loses logical-operation identity and complicates dependency semantics.
- Retry every failed operation automatically: unsafe for non-idempotent side effects.
- Delegate retry policy entirely to each Executor: makes workflow semantics backend-dependent.
