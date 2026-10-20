---
status: accepted
date: 2026-10-20
---

# Start Runs asynchronously and distinguish indeterminate external outcomes

A manual MCP workflow start is **always asynchronous**: it admits the Run and returns a Run ID without waiting for the Run to terminate; the caller uses separate atomic status, logs and result tools (**Q43=A**). When execution of an external operation cannot be confirmed as successful, failed, or physically stopped, the API and recorded Run/Step outcomes must preserve **indeterminate** as distinct from `failed` and `cancelled`, along with safe reasons for reconciliation (**Q44=A**).

## Rejected alternatives

- Sometimes block an MCP start call for its entire execution based on expected duration.
- Convert lost responses or unconfirmed cancellation into ordinary `failed` and make callers infer uncertainty from logs.

## Consequences

This is consistent with Q25=A (no blind retry of uncertain writes), Q33=A (truthful external cancellation) and Q36=A (granular atomic tools). Round 7 **Q50=A** keeps the first-release MCP surface limited to required atomic owner-facing operations (definitions, authorization, start, status, logs, result, cancellation, pause/resume) and rejects exposing arbitrary internal Attempt/D1/GitHub job management. The accepted distinctions do **not** establish an exact tool inventory, enum hierarchy for Run/Step/Attempt, event schema, reconciliation protocol, polling limits or failure-handling DSL semantics; those remain technical-spec questions. An indeterminate state is not proof that effects were rolled back.

Design only: no runtime code, merge, deploy, credentials change, or Tickets.
