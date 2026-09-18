# ADR 0018: Keep the Workflow MCP surface small and asynchronous

- Status: Accepted
- Date: 2026-09-17

## Context

Workflow definitions are expected to grow independently over time. Exposing each workflow as a distinct MCP tool would make the MCP schema change whenever workflows are added or removed, recreate tool-count and tool-name pressure, and couple workflow authoring to the external MCP interface.

Long-running workflows may wait on external events or remote executors, so a synchronous MCP request cannot safely represent the lifetime of a workflow run.

## Decision

Workflow MCP exposes a fixed generic control surface rather than one tool per workflow. v0.1 provides `workflow_list`, `workflow_get`, `workflow_run`, `workflow_status`, `workflow_result`, `workflow_logs`, and `workflow_cancel`.

`workflow_run` performs admission and returns promptly with the durable Workflow Run identity and initial state. It does not wait for terminal completion. Callers observe or retrieve completion through the status/result/log tools.

Workflow additions and removals change registry data, not the MCP tool schema.

Administrative credential and connection mutation is excluded from the model-facing Workflow MCP surface.

## Consequences

### Positive

- Workflow count does not inflate MCP tool count.
- Long-running execution does not hold an MCP request open.
- Workflow authoring and MCP schema evolution remain decoupled.
- The public control contract is easy for agents and portals to discover and cache.

### Negative

- Callers must perform follow-up status/result requests for asynchronous workflows.
- Workflow-specific input schemas are discovered through workflow metadata rather than through one statically generated MCP tool per workflow.

## Rejected alternatives

- Generate one MCP tool per workflow: convenient for a small registry but causes unbounded schema churn and tool proliferation.
- Keep `workflow_run` synchronous until completion: incompatible with durable waits and long external execution.
