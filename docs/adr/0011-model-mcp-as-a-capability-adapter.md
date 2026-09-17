# ADR 0011: Model MCP as a capability adapter, not an executor

- Status: Accepted
- Date: 2026-09-17

## Context

The workflow system must be able to call existing MCP servers, but MCP describes a remote capability protocol rather than an execution location. Treating MCP itself as an Executor would conflate "what operation is being invoked" with "where the workflow step runs" and would make executor selection depend on protocol choice.

Allowing workflow definitions to point at arbitrary MCP URLs would also create an uncontrolled network and credential boundary.

## Decision

MCP integrations are exposed through Capability Adapters. A workflow step invokes a capability such as `mcp.call`; the workflow engine still selects an actual Executor suitable for performing that capability.

MCP server targets are selected through named Connection References. A Connection Registry contains the administratively approved endpoint and credential relationship for each external MCP server. Workflow definitions refer to a Connection by name and do not provide arbitrary endpoint URLs or raw credentials inline.

The same Connection abstraction may later cover other external capability providers where a named, approved relationship is useful.

## Consequences

### Positive

- Capability semantics stay separate from execution placement.
- Existing MCP applications remain independent bounded contexts rather than being absorbed into the workflow engine.
- Approved connections provide a clear SSRF, credential, and egress policy boundary.
- Future Executors can invoke the same MCP capability without changing workflow definitions.

### Negative

- The workflow system needs lifecycle and authorization rules for Connection Registry entries.
- Dynamic arbitrary MCP endpoints require an explicit future design rather than working by default.
- Capability adapters must normalize protocol-specific errors and outputs into workflow-level execution semantics.

## Rejected alternatives

- MCP as an Executor: conflates protocol/capability with execution environment.
- Arbitrary MCP URL in workflow YAML: creates an uncontrolled egress and credential boundary.
- Copy existing MCP implementations into the workflow app: duplicates business logic and violates bounded-context isolation.
