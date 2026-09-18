# ADR 0025: Record runtime dependency snapshots without hashing them into definitions

- Original status: Accepted
- v0.1 disposition: SIMPLIFY
- v0.1 authority: `docs/workflow-mcp/v0.1-architecture-reduction.md`
- Date: 2026-09-17

## Context

A Workflow Definition can remain unchanged while an external dependency such as an MCP server changes its available tools, schemas, behavior, or version. Including remote schemas in the Workflow Definition digest would make workflow identity depend on mutable external systems and would require network access during compilation. Ignoring drift entirely would make failures difficult to explain.

## Decision

Remote dependency state is not part of Workflow Definition Version identity.

Before a Step Attempt uses an external capability contract, the relevant adapter resolves the live dependency and validates the requested operation against it. The Step Attempt records a Dependency Snapshot containing the connection identity, selected operation/tool, remote/server version when available, and a stable fingerprint of the effective contract/schema.

If the live dependency is incompatible with the Workflow Definition, execution fails explicitly with a contract error (for example tool not found or input schema mismatch). The runtime does not silently rewrite arguments or ask an AI to infer a replacement contract.

## Consequences

### Positive

- Workflow identity remains stable and storage-independent.
- Runtime drift is observable and explainable per attempt.
- Compilation does not depend on external systems being online.
- The system can distinguish "the workflow changed" from "the dependency changed."

### Negative

- The same Workflow Definition Version can produce different outcomes as external systems evolve.
- Reproducibility requires inspecting runtime provenance and dependency snapshots, not only the definition digest.
- Adapters must define deterministic contract fingerprints where possible.

## Rejected alternatives

- Hash live remote schemas into the Workflow Definition: couples identity to mutable network state and harms offline builds.
- Ignore external contract drift: obscures failures and encourages accidental parameter guessing.
