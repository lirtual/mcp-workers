---
status: accepted
date: 2026-10-20
---

# Cloudflare Workflows owns durable progression of a bounded DAG

Workflow MCP uses **Cloudflare Workflows** for durable workflow progression and waiting, with **D1** for coordination and queryable state, as decided in Round 2 **Q8=A**. Initial definitions support a bounded dependency DAG with conditions and parallel independent steps (**Q6=A**) rather than a sequential-only language or full n8n-style dynamic graph semantics. Supported ingress trigger types are manual, webhook, and Cron (**Q9=A**). This reuses a managed orchestrator rather than making GitHub Actions the sole engine or building a custom scheduler on D1/Queues.

## Considered alternatives

- GitHub Actions as the entire orchestration engine.
- A custom D1/Queues scheduler and state machine.
- Sequential-only workflows or full dynamic graph/loop support from v0.1.

## Consequences

Round 3 **Q18=A** has since selected GitHub Actions for registered heavy capabilities (ADR-0007). This ADR still does not finalize the D1 runtime schema, DAG syntax, parallelism limits, all event admission/cancellation/recovery details, or executor identity/callback protocol. Round 4 **Q23–Q25=A** has since set webhook event identity, timezone-aware Cron `misfire: latest`, and safety-sensitive retries (ADR-0010); **Q26=A** selects OIDC + atomic Attempt Claim (ADR-0011). Round 5 **Q34=A** (ADR-0013) selects D1 for small structured outputs and R2 only for large Artifacts; this does not change Cloudflare Workflows' progression authority. The exact persistence, reconciliation and callback mechanics remain open. Round 2 **Q10=A** independently establishes a single-owner product using the existing Portal authentication boundary without multi-tenant/RBAC infrastructure; it does not settle the permissions of individual external operations.
