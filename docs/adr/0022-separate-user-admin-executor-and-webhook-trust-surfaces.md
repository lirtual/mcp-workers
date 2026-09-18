# ADR 0022: Separate user, admin, executor, and webhook trust surfaces

- Status: Accepted
- Date: 2026-09-17

## Context

The initial deployment is single-user, but several actors still need fundamentally different authority: the MCP caller controls workflow runs, an administrator manages connections and credentials, external executors fetch scoped execution material and return results, and webhook senders may only trigger designated workflows.

Using one shared token because the system is single-user would let the compromise of a low-authority webhook or runner credential mutate credentials or control unrelated workflows.

## Decision

v0.1 is single-user and does not introduce general RBAC, organizations, teams, or workspaces. It nevertheless defines four separately authenticated Trust Surfaces:

1. User control: workflow discovery and run control through the Workflow MCP surface.
2. Administration: connection and credential lifecycle plus system configuration through a separate admin interface.
3. Executor: short-lived execution-scoped authority established through the executor authentication/delegation protocol.
4. Webhook trigger: per-trigger authority that can admit only the configured workflow/event path.

Credentials and permissions are not interchangeable across these surfaces. Administrative secret mutation is not exposed through the model-facing MCP tools.

## Consequences

### Positive

- Single-user simplicity is preserved without collapsing security boundaries.
- Webhook and runner compromise has limited blast radius.
- A future UI or CLI can share the admin interface without changing MCP privileges.
- The model-facing surface never needs to retrieve raw connection credentials.

### Negative

- Deployment requires more than one authentication mechanism/credential class.
- Administrative operations need a separate client path even for one operator.

## Rejected alternatives

- One bearer token for all endpoints: operationally simple but grants excessive authority to every integration path.
- Full RBAC in v0.1: unnecessary complexity for a single-user deployment.
