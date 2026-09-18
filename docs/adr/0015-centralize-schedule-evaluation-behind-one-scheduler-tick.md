# ADR 0015: Centralize schedule evaluation behind one scheduler tick

- Status: Accepted
- Date: 2026-09-17

## Context

A general workflow platform must support many workflow schedules. Mapping every schedule directly to a deployment-time platform cron binding consumes scarce platform trigger configuration and makes timezone and missed-run semantics depend on infrastructure topology rather than workflow semantics.

v0.1 has separately settled on Git-authored Workflow Definitions compiled into a bundled Workflow Registry. Schedule authoring must therefore remain part of the Workflow Definition rather than becoming a second runtime authoring source.

## Decision

v0.1 uses one periodic scheduler tick to evaluate schedule definitions from the active compiled Workflow Registry together with their persisted runtime scheduler state, and admits due Schedule Occurrences through the same normal Trigger Event and Run Admission path as other starts.

Schedule definitions contain cron plus an explicit timezone. A Schedule Occurrence has stable identity including the schedule and its intended logical scheduled time so duplicate scheduler ticks do not create duplicate runs.

The default misfire policy is `latest`: after scheduler downtime, admit only the latest missed occurrence rather than replaying every missed occurrence. Future policies such as `skip` and full `catchup` may be added later.

Runtime persistence stores scheduler progress and admission state (for example last/next intended occurrence), not editable schedule definitions. Adding or changing a v0.1 schedule follows the normal Git-authored Workflow Definition build/deploy path, but it does not require adding another infrastructure cron binding.

## Consequences

### Positive

- One infrastructure trigger can support many workflow schedules.
- Git remains the sole v0.1 source of authored workflow/schedule definitions.
- Timezone and misfire behavior are explicit workflow semantics.
- Scheduled events reuse the same deduplication and admission path as webhooks.

### Negative

- The workflow service must implement due-time evaluation and scheduler state.
- Scheduler outages require deliberate misfire handling.
- The tick frequency sets the practical scheduling resolution of v0.1.
- Changing a schedule in v0.1 requires the normal workflow build/deploy cycle because runtime authoring is intentionally deferred.

## Rejected alternatives

- One platform cron per workflow schedule: consumes deployment configuration and does not scale as the workflow catalog grows.
- Store editable schedule definitions in runtime persistence in v0.1: creates a second authoring source and conflicts with the Git-first registry decision.
- Replay every missed occurrence by default: can create a burst of stale work after downtime.
- Ignore all missed occurrences by default: can silently skip the latest expected scheduled job.
