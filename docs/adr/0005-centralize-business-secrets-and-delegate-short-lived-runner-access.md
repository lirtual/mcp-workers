# ADR 0005: Centralize business secrets and delegate short-lived runner access

- Status: Accepted
- Date: 2026-09-17

## Context

Workflow Steps may execute in more than one backend. A naive multi-executor design duplicates long-lived business credentials into each backend's secret store. That increases rotation work, creates drift between copies, widens exposure, and makes executor choice affect credential ownership.

GitHub-hosted execution still needs enough authority to retrieve job input and the credentials required by the current execution, but it should not become a second durable store for every workflow secret.

## Decision

The Workflow Automation system owns the authoritative long-lived business secrets used by workflow definitions. Workflow definitions contain only Secret References.

External Executors do not receive a durable copy of the workflow secret catalog. A dispatched execution receives a short-lived Credential Lease scoped to the job or execution purpose. The Executor uses that lease to obtain only the execution input and secret material required for the authorized step, and the lease expires or is invalidated after its permitted use.

GitHub Actions may hold only bootstrap material necessary to establish this delegated execution channel; it must not become the authoritative store for per-integration business credentials.

Secret values must not be embedded in workflow definitions, persisted as ordinary run data, included in dispatch payloads, or exposed in workflow outputs and logs.

## Consequences

### Positive

- Business credentials have one lifecycle and rotation authority.
- Adding an Executor does not require copying the entire secret catalog into it.
- A compromised or leaked execution lease has a narrower lifetime and scope than the underlying business credential.
- Executor selection remains separate from secret ownership.

### Negative

- External Executors require an authenticated callback/fetch protocol rather than receiving all data directly in the initial dispatch.
- The workflow service becomes security-critical for credential delegation and must enforce scope, expiry, replay protection, and redaction.
- Some third-party execution backends may require adapter-specific bootstrap configuration.

## Rejected alternatives

- Mirror all business secrets into GitHub Actions Secrets: simple initially but duplicates authority and complicates rotation.
- Put secret values in workflow YAML or dispatch payloads: unacceptable persistence and disclosure boundary.
