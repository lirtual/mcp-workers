# ADR 0008: Isolate DAG failure propagation

- Status: Accepted
- Date: 2026-09-17

## Context

A workflow DAG may contain independent branches. If one branch fails, immediately terminating all other branches discards valid work and makes failure handling, cleanup, and notification harder. Conversely, allowing dependents of a failed step to run by default can violate workflow assumptions.

The engine therefore needs an explicit and predictable rule for which parts of the graph remain runnable after failure.

## Decision

Workflow execution is not globally fail-fast by default. Failure or cancellation of a Step Run blocks only steps whose declared dependency conditions are no longer satisfied.

Independent branches may continue and retain their results. A workflow with one or more unhandled failed Step Runs has a failed final outcome even when independent branches completed successfully.

A dependent step does not run after a failed or cancelled prerequisite unless its Step Condition explicitly opts into failure-path execution. v0.1 supports an `always()` condition for cleanup, notification, and audit steps that must run after upstream completion regardless of success.

v0.1 does not add `continue-on-error`; failure remains observable at workflow outcome level.

## Consequences

### Positive

- Independent work is not discarded because an unrelated branch failed.
- Cleanup and notification paths can be modeled explicitly.
- Final workflow outcome still reflects real failures rather than silently masking them.

### Negative

- The engine must aggregate branch outcomes instead of stopping at the first failure.
- Workflow authors must understand dependency and condition semantics when designing failure paths.

## Rejected alternatives

- Global fail-fast: simple, but wastes independent work and complicates cleanup.
- Run all descendants regardless of prerequisite state: risks executing steps with invalid inputs.
- `continue-on-error` in v0.1: adds another failure-masking semantic before the base model is proven.
