# ADR 0010: Use a canonical workflow artifact store

- Status: Accepted
- Date: 2026-09-17

## Context

Steps may run in different executors and produce files, large text, archives, screenshots, or other binary results. Executor-native artifact stores have different retention and lifecycle rules, so making them part of workflow semantics would couple downstream steps to the backend that happened to create the artifact.

The workflow model needs one stable Artifact Reference regardless of executor.

## Decision

Workflow artifacts have a canonical workflow-level identity and storage location independent of executor-native temporary artifact mechanisms. In v0.1 the canonical byte store is Cloudflare R2.

Small structured results remain inline Step Outputs. Large, binary, or otherwise unsuitable results are stored as Artifacts and represented in workflow state by an Artifact Reference containing stable metadata such as artifact ID, logical name, media type, size, and content digest.

External executors upload artifacts through execution-scoped authorization. GitHub Actions artifacts may still be used for debugging or CI convenience, but they are not the authoritative workflow artifact location and must not be required to resolve a Workflow Run's durable outputs.

## Consequences

### Positive

- Downstream workflow logic uses one artifact model regardless of executor.
- Executor-specific retention does not define workflow data lifetime.
- Large payloads do not need to pass through dispatch parameters or ordinary workflow state.
- Artifact integrity can be checked with content digests.

### Negative

- Artifact lifecycle, retention, quotas, cleanup, and access control become responsibilities of the workflow system.
- External executors need an authenticated upload/download path.
- R2 introduces a storage dependency for workflows that emit large or binary results.

## Rejected alternatives

- GitHub Actions artifacts as the canonical store: ties workflow durability and retention to one executor.
- Persist all outputs inline: unsuitable for large or binary data and expensive for workflow state.
- Let every executor define its own artifact references: makes downstream steps executor-aware.
