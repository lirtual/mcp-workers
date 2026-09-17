# ADR 0006: Identify workflow versions by canonical content

- Status: Accepted
- Date: 2026-09-17

## Context

v0.1 workflow definitions are authored in Git, but the architecture intentionally preserves a future path to runtime-authored or imported definitions. Using a Git commit SHA as the Workflow Definition Version would couple version identity to one authoring backend and would not give identical definitions a common identity across sources.

A Workflow Run must retain the exact semantics it started with even if the source definition changes immediately afterward.

## Decision

A Workflow Definition Version is identified by a digest of the canonicalized definition content. The initial algorithm is SHA-256 over the canonical representation used by the workflow compiler.

Source metadata such as repository, commit, path, authoring channel, or import source is recorded as Definition Provenance but does not define the version identity.

Every Workflow Run binds to exactly one immutable Workflow Definition Version at creation time. Later edits create a different version and cannot alter an already-created run.

## Consequences

### Positive

- Git-authored, future runtime-authored, and imported definitions share one version model.
- A run remains reproducible independently of later source edits.
- Identical canonical definitions have the same semantic identity even when their provenance differs.

### Negative

- Canonicalization becomes a compatibility-sensitive contract and must be versioned carefully.
- Human-readable Git revisions remain useful provenance but are not sufficient as the workflow version identifier.
- The implementation must retain or reconstruct immutable definition content for active and inspectable historical runs.

## Rejected alternatives

- Git commit SHA as the version: couples the model to Git and identifies repository state rather than canonical workflow semantics.
- Mutable workflow ID only: makes historical runs ambiguous after edits.
