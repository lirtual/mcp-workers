---
status: accepted
date: 2026-10-20
---

# Use GitHub Actions for registered heavy execution capabilities

Cloudflare Workflows remains the sole durable orchestrator (**Q8=A**) and may delegate registered heavy operations such as browser automation, CLI programs, and Python jobs to a **GitHub Actions executor** (**Q18=A**). Workflow definitions cannot submit arbitrary shell scripts to this executor merely by being published. This reuses existing GitHub Actions infrastructure and avoids forcing all business execution into the Cloudflare Workers runtime.

## Alternatives considered

- Cloudflare-only execution in the first release.
- Using GitHub Actions as the *entire* workflow orchestrator (rejected already by Q8=A).
- An additional general-purpose heavy-execution scheduler/cluster.

## Consequences

Dynamic MCP Server discovery (**Q7=B**) and the restriction to **registered heavy executor capabilities** are distinct boundaries: the latter does not create a registration requirement for MCP Servers. The GitHub Actions management MCP and Workflow MCP's heavy executor have distinct operational responsibilities and are not assumed to share token authority.

Round 4 **Q26=A and Q27=A** (ADR-0011) further confirms GitHub OIDC plus atomic D1 Attempt Claim and a separate minimal-scope execution credential, not the management MCP multi-PAT pool. The exact executor protocol, job registration, OIDC issuer/audience/ref checks, dispatch reconciliation, callback ordering, cancellation and large output/artifact transport remain **open**. Historical v0.1 implementation details are candidates, not automatically approved.

Design decision only. No implementation, merge, deployment, credentials, or Tickets are authorized.
