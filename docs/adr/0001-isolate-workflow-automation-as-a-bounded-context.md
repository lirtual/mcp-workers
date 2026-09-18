# ADR 0001: Isolate Workflow Automation as a Bounded Context

- Status: Accepted
- Date: 2026-09-17

## Context

The repository currently contains independently deployed MCP Worker applications and explicitly avoids turning the monorepo itself into a common MCP runtime platform. A new workflow capability is intended to coordinate reusable automations and may invoke existing MCP capabilities, which creates a risk of coupling unrelated applications through shared runtime, storage, credentials, or release behavior.

## Decision

Workflow Automation will be introduced as a new bounded context and, when implemented, as an independent MCP application rather than as a new repository-wide runtime layer.

Existing MCP applications remain autonomous. They do not need to migrate to a shared workflow runtime, shared database, shared credential model, or shared release lifecycle.

The workflow system may invoke existing MCP applications as external capabilities, but it does not absorb or redefine their domain models.

## Consequences

### Positive

- Existing MCP apps keep their current operational and security boundaries.
- The workflow system can evolve independently without forcing cross-app migrations.
- Existing tools can become workflow capabilities without being rewritten as workflow-native integrations.
- Failure or redesign of the workflow system does not invalidate the standalone MCP applications.

### Negative

- Cross-app calls require explicit capability adapters or MCP invocation contracts.
- Some concepts such as authentication, observability, or schemas may exist independently in the workflow app and other MCP apps.
- The repository remains a collection of deployable apps rather than a single unified runtime platform.

## Rejected alternative

Turn `mcp-workers` itself into a central workflow/MCP platform shared by all existing apps. This would contradict the established repository isolation model and create unnecessary migration coupling.
