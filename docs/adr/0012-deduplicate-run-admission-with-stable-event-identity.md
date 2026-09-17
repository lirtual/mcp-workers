# ADR 0012: Deduplicate run admission with stable event identity

- Status: Accepted
- Date: 2026-09-17

## Context

Webhook delivery, scheduler ticks, caller retries, and network recovery can deliver the same logical start request more than once. Treating every delivery as a new workflow would create duplicate runs and amplify downstream side effects. At the same time, the workflow system cannot honestly guarantee exactly-once execution across arbitrary external systems because a remote side effect may succeed while its acknowledgement is lost.

## Decision

The workflow system guarantees at-most-one Workflow Run admission for equivalent trigger events, not exactly-once downstream execution.

Webhook and scheduled starts must produce stable event identity. Admission uses a stable key derived from workflow, trigger, and event identity so repeated delivery resolves to the already admitted Workflow Run.

Manual starts create a new Workflow Run by default. A manual caller may provide an idempotency key when it wants repeated equivalent requests to resolve to one admitted run.

A duplicate admission request returns the existing Workflow Run identity rather than failing as a duplicate.

Run-admission deduplication is distinct from Step-level execution idempotency. Downstream retry semantics continue to rely on stable Operation IDs and capability-specific idempotency behavior.

v0.1 does not expire admission identity with a deduplication TTL; retention policy is deferred until real data volume justifies it.

## Consequences

### Positive

- Repeated webhook and scheduler delivery does not create duplicate workflow runs.
- Callers can safely retry start requests and recover the same run identity.
- The contract avoids an unprovable exactly-once guarantee.
- Admission idempotency and downstream side-effect idempotency remain separate concepts.

### Negative

- Trigger adapters must define stable event identity.
- Admission state grows until a later explicit retention policy is introduced.
- A bad event-key design can incorrectly collapse distinct events or fail to collapse duplicates.

## Rejected alternatives

- Claim exactly-once execution: impossible to guarantee across arbitrary external side effects and ambiguous acknowledgements.
- Treat duplicate events as errors: creates unnecessary retry complexity and poor caller ergonomics.
- Use a short fixed deduplication TTL in v0.1: risks duplicate historical event admission before real retention requirements are understood.
