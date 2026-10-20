---
status: accepted
date: 2026-10-20
---

# Keep workflow expressions restricted and DAG execution bounded

Workflow MCP's initial declarative DSL uses **restricted, typed expressions** for field references, scalar comparisons, and boolean conditions rather than arbitrary JavaScript evaluation or user-defined functions (**Q40=A**). A Step runs by default only when its declared dependencies succeeded. Explicit failure-handling or always-run conditions may override that default, but cannot override the already-confirmed Run cancellation gate (**Q41=A**). Definitions must have finite Step-count and concurrent-ready-Step limits, checked during validation and respected at runtime (**Q42=A**).

## Rejected alternatives

- `eval` or freely executable JavaScript/custom expression functions.
- Continuing all dependent Steps by default after an upstream failure.
- Unbounded parallel execution of ready Steps.

## Consequences

These semantics extend the bounded-DAG direction (Q6=A), safety-sensitive retry policy (Q25=A), registered heavy-capability rule (Q18=A) and truthful cancellation (Q33=A), without introducing a code sandbox, dynamic graph loop engine or extra task queue. The exact grammar, type system, Step limit values, resource quota behavior, condition predicates, dependency-terminal semantics (including skipped and indeterminate dependencies), and validation error schema remain **open** technical-spec details. No script execution permission or retry expansion is granted by this ADR.

Design only: no runtime code, merge, deploy, credentials change, or Tickets.
