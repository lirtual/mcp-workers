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

This ADR does not select any heavy-task executor, finalize D1 schemas, choose DAG syntax, define parallelism limits, or settle event admission/misfire/cancellation/recovery policies. Those are later dependent decisions. Round 2 **Q10=A** independently establishes a single-owner product using the existing Portal authentication boundary without multi-tenant/RBAC infrastructure; it does not settle the permissions of individual external operations.
