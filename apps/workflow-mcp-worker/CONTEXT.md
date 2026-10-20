# Workflow MCP Context

Workflow MCP is a planned, independently owned bounded context for orchestrating existing MCP capabilities and external operations. It is AI/MCP-first, not a clone of a general-purpose visual automation platform.

## Language

**Workflow**:
A declarative description of how registered capabilities are coordinated to achieve a result.
_Avoid_: Script, GitHub Actions workflow (when referring to Workflow MCP definitions)

**Workflow Definition**:
The versionable YAML/JSON description of a Workflow, suitable for review and validation before execution.
_Avoid_: Executable program, visual canvas

**Workflow MCP**:
The MCP-facing automation product that defines and manages Workflows while preserving the separate ownership of upstream MCP Workers.
_Avoid_: n8n replacement, unified MCP platform

## Boundaries

- This context is planned under `apps/workflow-mcp-worker` in the existing `lirtual/mcp-workers` monorepo; implementation has **not** been authorized by the design discussion.
- Workflow MCP composes other capabilities. It does not take ownership of upstream MCP Workers' tools, credentials, business rules, or release lifecycles.
- ChatGPT / AI agents using MCP are the primary interaction surface. A visual editor is not a prerequisite.
- YAML/JSON is the intended declarative definition format; its exact schema, storage, publication, and runtime semantics remain **unresolved**.
- The 2026-09-18 Workflow MCP v0.1 technical specification is the review baseline, not blanket approval of its technical choices. Pending decisions must remain pending.

See [ADR-0001](docs/adr/0001-mcp-native-product-boundary.md) and [Grill With Docs decisions](docs/design/grill-with-docs.md).
