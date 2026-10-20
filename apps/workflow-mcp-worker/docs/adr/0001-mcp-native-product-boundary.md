---
status: accepted
date: 2026-10-20
---

# MCP-native Workflow product boundary

Workflow MCP is an AI/MCP-first orchestration product that composes existing MCP tools, registered HTTP capabilities, and external executors, rather than recreating n8n, Zapier, or an independent integration marketplace. Its planned home is an independently owned `apps/workflow-mcp-worker` bounded context inside the existing `lirtual/mcp-workers` monorepo, reusing repository infrastructure without centralizing other Workers' business logic. Workflow definitions are declarative YAML/JSON and a visual editor is not required for the initial product. This boundary reduces duplicated connectors, infrastructure, and maintenance while preserving the ability to add features only when usage justifies them.

This ADR captures **only** Grill With Docs Round 1 decisions Q1=A, Q2=A, Q3=A. The owner's Q4=A process decision is recorded in the discussion log; it makes the prior v0.1 specification a review baseline, **not** an automatic ratification of its engine, persistence, permissions, or runtime-design details.

## Considered alternatives

- A n8n/Zapier-style full automation platform with a first-class visual editor and proprietary connector ecosystem.
- A standalone repository and independently maintained CI/release system.
- Replacing the earlier v0.1 review material rather than reconciling it.

## Consequences

Future design questions must respect the independently owned context and MCP-first interaction model. Round 2 has since settled runtime-managed definition publishing (**ADR-0002**), unrestricted preregistration-free dynamic MCP targets (**ADR-0003**), and bounded DAG orchestration via Cloudflare Workflows (**ADR-0004**). Round 3 has since confirmed draft/publish/version-pinned D1 definitions (ADR-0005), dynamic MCP HTTP authentication/network/operation boundaries (ADR-0006), and GitHub Actions for registered heavy capabilities (ADR-0007). Round 4 subsequently confirmed publish-with-authorization and operation-drift reapproval (ADR-0008), encrypted D1 target credentials (ADR-0009), safe trigger/retry policies (ADR-0010), and GitHub OIDC/atomic Claim with least-privilege credentials (ADR-0011). Remaining details are precise identities/grants, cryptographic key lifecycle, SSRF enforcement, callback/reconciliation, protocol-version interoperability and operational recovery, not these already chosen directions. No code implementation, deploy, merge, or production change is authorized by this ADR.
