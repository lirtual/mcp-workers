# ADR 0027: Separate definition identity from runtime provenance

- Status: Accepted
- Date: 2026-09-17

## Context

The same Workflow Definition Version can run under different workflow-engine builds, executor implementations, and external dependency states over time. Treating the definition digest as a complete reproducibility fingerprint would be misleading, while hashing every runtime dependency into definition identity would make the definition unstable and operationally coupled.

## Decision

Workflow Definition Version identifies only the canonical workflow definition.

Each Workflow Run additionally records Runtime Provenance for the workflow engine/build that interpreted and orchestrated it. Each Step Attempt records executor provenance (including the GitHub workflow/run and runner implementation revision where applicable) plus its Dependency Snapshot.

Operational diagnosis and historical replay analysis use the combination of:

- Workflow Definition Version;
- workflow-engine Runtime Provenance;
- executor Runtime Provenance;
- external Dependency Snapshot.

These provenance records explain execution context but do not alter Workflow Definition Version identity.

## Consequences

### Positive

- Definition identity remains simple and stable.
- Runtime/environment changes remain traceable without contaminating authoring semantics.
- Historical failures can be compared across engine, runner, and dependency changes.

### Negative

- A definition digest alone is insufficient to claim bit-for-bit reproducibility.
- Run/attempt records must preserve provenance fields long enough to remain diagnostically useful.
- Build/version identifiers need deterministic generation in CI/deploy pipelines.

## Rejected alternatives

- Hash engine/executor/dependencies into the workflow definition: conflates authored meaning with execution environment.
- Record no runtime provenance: makes same-definition behavior changes unnecessarily opaque.
