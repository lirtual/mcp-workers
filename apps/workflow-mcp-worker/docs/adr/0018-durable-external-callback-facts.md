---
status: accepted
date: 2026-10-20
---

# Record external Attempt callbacks durably before signaling the orchestrator

External GitHub Actions execution callbacks are authenticated and **recorded as durable, idempotent facts before** Workflow MCP signals a waiting Cloudflare Workflow (**Q48=A**). Repeated or late callbacks must not corrupt the logical Attempt state. Notification failure after fact persistence must remain recoverable by a bounded reconciliation mechanism rather than relying exclusively on one ephemeral `sendEvent` call.

## Rejected alternative

- Deliver external callbacks only as direct Workflow notifications without an independently queryable durable receipt.

## Consequences and pending technical choices

The D1 callback inbox is a coordination/recovery record, **not** a second DAG orchestrator or generic message queue. It refines Q26 (OIDC + atomic Attempt Claim), Q33/Q44 (truthful cancellation and indeterminate outcomes), and Q35 (cross-version recovery). Exact signed claims and correlation tuple, callback schema, monotonic receipt ordering, delivery cursor, wake-up frequency, early-event race, instance notification API and timeout/reconciliation state machine must be specified and tested. An HTTP callback accepted or a GitHub job completed is not sufficient proof that the logical Run succeeded.

Design only; no runtime code, new deployment component, schema migration, merge, credentials or Tickets.
