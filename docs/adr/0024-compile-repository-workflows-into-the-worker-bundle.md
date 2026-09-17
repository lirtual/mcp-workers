# ADR 0024: Compile repository workflows into the Worker bundle

- Status: Accepted
- Date: 2026-09-17

## Context

v0.1 uses Git as the source of truth for Workflow Definitions. Reading private-repository workflow files from GitHub on every list/get/run would add runtime GitHub content credentials, network dependency, and a second interpretation path separate from the canonical validation/hash pipeline.

Schedule authoring must also remain consistent with the Git-owned definition model: runtime storage should hold scheduler state, not become a second source of authored schedule definitions.

## Decision

v0.1 compiles repository-authored Workflow YAML at build time into a generated Workflow Registry bundled with the Workflow Worker.

The build pipeline parses YAML, validates schema and DAG structure, parses restricted expressions, validates capabilities/references, produces the Canonical Workflow Representation, derives the definition digest, and emits generated registry data consumed at runtime.

Runtime MCP operations such as `workflow_list`, `workflow_get`, and `workflow_run` read only the bundled registry. They do not fetch workflow source from GitHub.

Schedule definitions are part of the compiled Workflow Definition. Runtime persistence stores scheduler progress and admission state (for example last/next occurrence), not v0.1 schedule authoring.

## Consequences

### Positive

- One validation/normalization pipeline defines both runtime behavior and version identity.
- Workflow discovery/run startup has no GitHub Contents API dependency.
- Invalid workflow definitions fail build/CI rather than failing after deployment.
- Git remains the sole v0.1 authoring source.

### Negative

- Editing a v0.1 Workflow Definition requires a build/deploy before it becomes active.
- Generated registry code/data becomes a build artifact that must stay deterministic.
- Future runtime-authored workflows will need an additional registry source while preserving the same canonical compiler contract.

## Rejected alternatives

- Fetch YAML from GitHub at runtime: adds credentials/network coupling and duplicate interpretation paths.
- Store editable definitions in D1 in v0.1: contradicts the accepted Git-first authoring boundary.
