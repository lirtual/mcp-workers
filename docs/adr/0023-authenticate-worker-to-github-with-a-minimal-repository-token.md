# ADR 0023: Authenticate Worker-to-GitHub calls with a minimal repository token

- Status: Accepted
- Date: 2026-09-17

## Context

GitHub Actions OIDC authenticates a running GitHub job to the Workflow service. It does not authorize the Workflow Worker to call GitHub APIs to dispatch or cancel Actions runs. The outbound direction therefore needs a separate credential.

v0.1 is a single-user private-repository system. Introducing a GitHub App installation flow now would add application keys, JWT creation, installation-token lifecycle, and more operational surface before multi-repository delegation is required.

## Decision

The Workflow Worker uses one fine-grained GitHub token scoped to the `lirtual/mcp-workers` repository and the minimum GitHub Actions write authority required for dispatch/cancellation.

The token is a platform-level secret of the Workflow Worker. It is not a workflow business secret, is never placed in workflow definitions, dispatch payloads, run state, executor leases, or logs, and is not exposed through MCP.

Worker-to-GitHub and GitHub-to-Worker authentication remain separate:

- Worker -> GitHub: repository-scoped fine-grained token.
- GitHub -> Worker: GitHub Actions OIDC, validated before issuing a scoped Credential Lease.

The Workflow Worker records the returned GitHub workflow-run identity on the corresponding Step Attempt so later status correlation and cancellation do not require guessing which run was created.

## Consequences

### Positive

- Closes the outbound authentication gap without weakening the OIDC-based inbound runner identity.
- Keeps v0.1 setup small and compatible with a single private repository.
- Enables deterministic cancellation by storing GitHub run identity per attempt.

### Negative

- Adds one long-lived platform credential to rotate.
- The design is intentionally repository-specific in v0.1.
- A future multi-user/multi-repository service should prefer a GitHub App installation model.

## Rejected alternatives

- Reuse GitHub OIDC for Worker-to-GitHub calls: wrong authentication direction and not an API credential for the Worker.
- Store a broad classic PAT: unnecessarily wide authority.
- Build a GitHub App immediately: better for multi-tenant distribution, but unnecessary complexity for v0.1.
