# ADR 0003: Version-control workflow definitions before runtime authoring

- Status: Accepted
- Date: 2026-09-17

## Context

The Workflow Automation context is intended to support a growing catalog of reusable workflows. Workflow definitions could live only in version control, only in runtime storage, or in both. Runtime authoring is desirable later because MCP clients may eventually create and edit workflows directly, but making runtime storage authoritative in the first release would immediately require authoring APIs, conflict semantics, validation, migrations, history, rollback, and synchronization rules.

The first release also needs definitions to be reviewable, reproducible, and easy to roll back while the DSL is still evolving.

## Decision

For v0.1, workflow definitions are authored and versioned in the Git repository and Git is the source of truth for definition content.

Runtime persistence stores executions, state, events, deduplication records, and references to the immutable definition version used by each run; it is not the authoring source of truth in v0.1.

The domain model and public contracts must nevertheless preserve room for future runtime authoring. A later release may add create/update/delete operations without changing the identity or execution semantics of Workflow Definition and Workflow Definition Version.

## Consequences

### Positive

- Definition changes are reviewable through ordinary repository history.
- Rollback and comparison are straightforward while the DSL is young.
- v0.1 avoids building a workflow editor, synchronization protocol, and definition-conflict model.
- A Workflow Run can be tied to an immutable definition revision for reproducibility.

### Negative

- Creating or editing a workflow in v0.1 requires a repository change and deployment/synchronization path.
- MCP clients cannot initially persist arbitrary new workflow definitions at runtime.
- Future runtime authoring must introduce a clear ownership/synchronization model rather than silently creating a second source of truth.

## Rejected alternatives

- Runtime database as the only definition source in v0.1: too much authoring and lifecycle machinery before execution semantics are proven.
- Git and runtime storage as equal writable sources from day one: creates conflict and synchronization semantics with little initial value.
