# ADR 0015: Centralize schedule evaluation behind one scheduler tick

- Status: Accepted
- Date: 2026-09-17

## Context

A general workflow platform must support many runtime-defined schedules. Mapping every workflow schedule directly to deployment-time platform cron bindings couples authoring to redeployment and consumes scarce platform trigger configuration. It also makes timezone and missed-run semantics dependent on infrastructure configuration rather than workflow semantics.

## Decision

v0.1 uses one periodic scheduler tick to evaluate runtime schedule definitions and admit due Schedule Occurrences through the same normal Trigger Event and Run Admission path as other starts.

Schedule definitions contain cron plus an explicit timezone. A Schedule Occurrence has stable identity including the schedule and its intended logical scheduled time so duplicate scheduler ticks do not create duplicate runs.

The default misfire policy is `latest`: after scheduler downtime, admit only the latest missed occurrence rather than replaying every missed occurrence. Future policies such as `skip` and full `catchup` may be added later.

Workflow schedules are runtime resources. Adding or changing a workflow schedule must not require adding another deployment-time cron binding or redeploying the Worker solely for that schedule change.

## Consequences

### Positive

- One infrastructure trigger can support many workflow schedules.
- Workflow schedule changes become runtime configuration rather than deployment topology.
- Timezone and misfire behavior are explicit workflow semantics.
- Scheduled events reuse the same deduplication and admission path as webhooks.

### Negative

- The workflow service must implement due-time evaluation and scheduler state.
- Scheduler outages require deliberate misfire handling.
- The tick frequency sets the practical scheduling resolution of v0.1.

## Rejected alternatives

- One platform cron per workflow schedule: consumes deployment configuration and does not scale as a runtime authoring model.
- Replay every missed occurrence by default: can create a burst of stale work after downtime.
- Ignore all missed occurrences by default: can silently skip the latest expected scheduled job.
