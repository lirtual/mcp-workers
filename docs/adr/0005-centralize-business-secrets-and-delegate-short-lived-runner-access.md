# ADR 0005: Centralize business secrets and delegate short-lived runner access

- Original status: Accepted
- v0.1 disposition: SIMPLIFY
- v0.1 authority: `docs/workflow-mcp/v0.1-architecture-reduction.md`
- Date: 2026-09-17

## Context

Workflow Steps may execute in more than one backend. A naive multi-executor design duplicates long-lived business credentials into each backend's secret store. That increases rotation work, creates drift between copies, widens exposure, and makes executor choice affect credential ownership.

External execution still needs enough authority to retrieve job input and the credentials required by the current execution, but it should not become a second durable store for every workflow secret.

## Decision

The Workflow Automation system owns the authoritative long-lived business secrets used by workflow definitions. Workflow definitions contain only Secret References.

External Executors do not receive a durable copy of the workflow secret catalog. They establish their execution identity through an executor-specific trust mechanism and receive a short-lived Credential Lease scoped to the job or execution purpose. The Executor uses that lease to obtain only the execution input and secret material required for the authorized step, and the lease expires or is invalidated after its permitted use.

For the GitHub Executor, the trust bootstrap is GitHub Actions OIDC rather than a long-lived bootstrap secret stored in GitHub. The detailed GitHub trust decision is recorded separately in ADR 0009.

Secret values must not be embedded in workflow definitions, persisted as ordinary run data, included in dispatch payloads, or exposed in workflow outputs and logs.

## Consequences

### Positive

- Business credentials have one lifecycle and rotation authority.
- Adding an Executor does not require copying the entire secret catalog into it.
- A compromised or leaked execution lease has a narrower lifetime and scope than the underlying business credential.
- Executor selection remains separate from secret ownership.
- The GitHub Executor does not require a durable workflow-service bootstrap secret.

### Negative

- External Executors require an authenticated callback/fetch protocol rather than receiving all data directly in the initial dispatch.
- The workflow service becomes security-critical for credential delegation and must enforce scope, expiry, replay protection, and redaction.
- Each external executor needs an appropriate trust bootstrap mechanism.

## Rejected alternatives

- Mirror all business secrets into GitHub Actions Secrets: simple initially but duplicates authority and complicates rotation.
- Store a long-lived workflow-service bootstrap secret in GitHub when OIDC is available: unnecessarily widens the durable secret surface.
- Put secret values in workflow YAML or dispatch payloads: unacceptable persistence and disclosure boundary.
