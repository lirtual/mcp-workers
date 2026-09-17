# ADR 0009: Authenticate the GitHub Executor with OIDC

- Original status: Accepted
- v0.1 disposition: SIMPLIFY
- v0.1 authority: `docs/workflow-mcp/v0.1-architecture-reduction.md`
- Date: 2026-09-17

## Context

The GitHub Executor must fetch execution input, receive narrowly scoped secret material, upload results, and report completion. Keeping a long-lived workflow-service bootstrap secret in GitHub Actions would create a durable credential copy and an additional rotation boundary.

GitHub Actions can issue short-lived OIDC identity tokens for a running job, allowing the workflow service to authenticate the job itself before issuing a narrower execution credential.

## Decision

The GitHub Executor uses GitHub Actions OIDC as its trust bootstrap. The GitHub job requests an OIDC token and presents it to the Workflow Automation service. The service validates the token's issuer, audience, repository identity, and the workflow/ref claims required by the configured trust policy.

After successful validation, the service issues a short-lived Credential Lease bound to the specific Execution Request. That lease authorizes only the operations needed by that execution, such as fetching normalized input, obtaining the current step's approved secret material, uploading artifacts, and submitting the execution result.

The GitHub dispatch payload contains only non-secret execution identifiers needed to locate the Execution Request. The GitHub Executor does not store a long-lived workflow-service bootstrap secret.

Callback/result delivery is correlated to the Execution Request and must be replay-resistant. The orchestrator must tolerate completion arriving before it reaches its logical wait point.

## Consequences

### Positive

- No durable workflow-service credential must be stored in GitHub Actions.
- Trust can be scoped to explicit repository/workflow/ref identities.
- Compromise of one execution lease does not grant durable access to the workflow secret catalog.
- GitHub remains an execution backend rather than a credential authority.

### Negative

- OIDC verification and claim policy become security-critical code.
- Repository/workflow/ref changes may require trust-policy updates.
- Local emulation of the GitHub Executor needs a separate development trust path and cannot pretend to be production OIDC.

## Rejected alternatives

- Long-lived GitHub Actions bootstrap secret: simpler but widens the permanent secret surface and creates rotation work.
- Put business secrets directly in `workflow_dispatch`: exposes secrets to the dispatch boundary and run metadata.
- Treat any valid GitHub OIDC token as trusted: too broad; repository and workflow identity must be constrained.
