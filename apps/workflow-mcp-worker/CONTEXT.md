# Workflow MCP Context

Workflow MCP is a planned, independently owned bounded context for orchestrating existing MCP capabilities and external operations. It is AI/MCP-first, not a clone of a general-purpose visual automation platform.

## Language

**Workflow**:
A declarative description of how capabilities and steps are coordinated to achieve a result.
_Avoid_: Script, GitHub Actions workflow (when referring to Workflow MCP definitions)

**Workflow Definition**:
The editable YAML/JSON description of a Workflow that can be created, changed, and published by the owner.
_Avoid_: Executable program, visual canvas

**Workflow MCP**:
The MCP-facing automation product that defines and manages Workflows while preserving the separate ownership of upstream MCP Workers.
_Avoid_: n8n replacement, unified MCP platform

**MCP Target**:
An MCP Server selected as a source of tools for a Workflow; prior registration is not required.
_Avoid_: Pre-registered Connection (when referring to every callable MCP Server)

## Boundaries

- This context is planned under `apps/workflow-mcp-worker` in the existing `lirtual/mcp-workers` monorepo; implementation has **not** been authorized by the design discussion.
- Workflow MCP composes other capabilities. It does not take ownership of upstream MCP Workers' tools, credentials, business rules, or release lifecycles.
- ChatGPT / AI agents using MCP are the primary interaction surface. A visual editor is not a prerequisite.
- YAML/JSON is the intended declarative definition format. The authenticated owner can create, edit, and publish definitions **at runtime through MCP**, with definition data held by the runtime system rather than published only through Git.
- Workflow MCP supports **dynamic discovery and invocation of arbitrary MCP Servers without preregistration**. This does not itself decide transport/authentication, secret handling, network egress/SSRF defense, or side-effect approvals.
- The initial workflow graph is a **bounded DAG** with dependencies, conditions, and parallel steps; arbitrary loops and full dynamic graph semantics are out of initial scope.
- **Cloudflare Workflows** owns durable orchestration, while **D1** holds coordination and queryable state. Heavy-task execution and its boundaries are not yet decided.
- Supported trigger types are **manual**, **webhook**, and **Cron**; delivery and recovery semantics are still open.
- The initial product uses a **single owner** authenticated through the existing MCP Portal; no multi-user/RBAC system is required. Operation-specific access policy is still open.
- The 2026-09-18 Workflow MCP v0.1 technical specification remains the review baseline. Its Git-only/static-definition and static MCP Connection assumptions are **superseded by Q5=B and Q7=B**, respectively. All other unconfirmed design details remain open.

See [ADR-0001](docs/adr/0001-mcp-native-product-boundary.md), [ADR-0002](docs/adr/0002-runtime-managed-definitions.md), [ADR-0003](docs/adr/0003-dynamic-mcp-targets.md), [ADR-0004](docs/adr/0004-cloudflare-workflows-and-bounded-dag.md), and [Grill With Docs decisions](docs/design/grill-with-docs.md).
