# ADR 0017: Compile authoring YAML into a restricted canonical IR

- Original status: Accepted
- v0.1 disposition: SIMPLIFY
- v0.1 authority: `docs/workflow-mcp/v0.1-architecture-reduction.md`
- Date: 2026-09-17

## Context

A workflow definition needs a convenient human authoring format, deterministic version identity, static validation, and safe data-dependent conditions. If YAML strings are treated as executable JavaScript or another ambient programming language, the platform becomes difficult to analyze, secure, migrate, and reproduce. Authoring syntax also should not determine semantic identity because formatting-only edits must not create different workflow meaning.

## Decision

YAML is the v0.1 human authoring format. It is parsed and compiled into a deterministic canonical JSON-like intermediate representation before execution and before Workflow Definition Version hashing.

Compilation performs schema validation, DAG validation, expression parsing, capability/reference validation, and normalization. The canonical representation is deterministically serialized and hashed to identify the Workflow Definition Version.

Workflow expressions compile into a restricted AST. v0.1 expressions may read declared workflow input, trigger data, workflow metadata/status, and prior step outputs; they may use a small fixed set of comparison, boolean, null-coalescing, and status functions such as `success()`, `failure()`, and `always()`.

Expressions cannot evaluate arbitrary JavaScript, execute code, access files or network resources, dynamically import modules, or call undeclared functions.

Secret references are typed reference objects rather than ordinary template strings so secret values cannot accidentally flow through generic string interpolation, outputs, or logs.

## Consequences

### Positive

- Workflow meaning is deterministic and statically inspectable.
- Formatting-only authoring changes need not change semantic version identity.
- Expression evaluation has a narrow security and test surface.
- Capability, dependency, and reference errors can fail before a run starts.
- Secret handling stays outside generic template interpolation.

### Negative

- A compiler/validator layer must be maintained.
- The restricted expression language is less flexible than arbitrary JavaScript.
- New expression operators/functions require explicit language evolution and compatibility tests.

## Rejected alternatives

- Execute arbitrary JavaScript inside `if` or interpolation: difficult to sandbox, analyze, and reproduce.
- Hash raw YAML bytes: makes comments/formatting accidental version identity.
- Resolve secret values through normal string templates: increases accidental disclosure and logging risk.
