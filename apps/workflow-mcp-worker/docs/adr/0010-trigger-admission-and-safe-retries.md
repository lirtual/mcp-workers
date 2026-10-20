---
status: accepted
date: 2026-10-20
---

# Identify triggers explicitly and retry external operations only when safe

Workflow MCP requires webhook-specific authentication and a stable event identifier so duplicate deliveries of the same event map to one logical Run (**Q23=A**); body-content hashing is not the general event-identity contract because legitimate identical payloads can represent different occurrences. Scheduled triggers declare a timezone and default to `misfire: latest`, admitting at most the latest missed scheduled occurrence after downtime rather than automatically replaying every missed interval (**Q24=A**). External operations may use bounded automatic retries only when the operation is read-only or proven idempotent; uncertain externally-effectful writes must not be blindly reissued and require outcome verification or truthful uncertain-state reporting (**Q25=A**).

## Rejected alternatives

- Hashing request bodies to infer event identity.
- Replaying all missed scheduled occurrences by default.
- Uniform exponential retries for all MCP tools, including possibly completed external writes.

## Consequences

The exact webhook identity namespace/retention, scheduler's timezone and DST interpretation, trigger admission atomicity, unknown-outcome reconciliation, which operation metadata is trustworthy, retry quotas and terminal-state vocabulary remain undecided. D1 may hold admission and query facts but **Cloudflare Workflows alone** progresses the DAG (ADR-0004). This ADR does not create a second event queue, retry scheduler or event-sourcing platform.

Design only: no implementation, merge, deployment, or Tickets.
