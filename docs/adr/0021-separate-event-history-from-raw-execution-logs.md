# ADR 0021: Separate authoritative event history from raw execution logs

- Status: Accepted
- Date: 2026-09-17

## Context

Workflow callers need a durable explanation of what happened: run creation, step transitions, retries, artifacts, waits, cancellation, and terminal state. Executor stdout/stderr and adapter debug output are useful during investigation but are verbose, backend-specific, potentially sensitive, and not reliable as workflow state.

Treating platform log streams as the only history would make workflow status dependent on observability retention and parsing implementation text.

## Decision

The Workflow Automation domain maintains an ordered structured Event Timeline as authoritative user-facing execution history. Domain events include run and step lifecycle transitions, retries, executor dispatch/result correlation, artifact creation, waits, cancellation, and terminal outcomes.

`workflow_logs` reads the structured Event Timeline rather than scraping executor logs.

Raw Execution Logs are diagnostic data only. When retained, they must be sanitized/redacted and stored or referenced separately from canonical workflow state. Platform observability remains operational telemetry and is not the source of truth for workflow status.

## Consequences

### Positive

- Workflow history survives executor and observability implementation changes.
- User-facing logs have stable structured semantics.
- Secret-redaction and retention policy can differ between timeline and verbose debug material.
- Run status never depends on parsing human-oriented log lines.

### Negative

- The workflow service must emit domain events explicitly.
- Debugging may require following a reference from the timeline to separate raw log material.

## Rejected alternatives

- Store all stdout/stderr in the primary workflow database: noisy, costly, and increases credential leakage risk.
- Derive run history from platform observability: retention and schema are not a domain contract.
