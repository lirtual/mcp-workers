# ADR 0004: Use declarative acyclic workflows and explicit code capabilities

- Status: Accepted
- Date: 2026-09-17

## Context

A workflow DSL can range from a simple sequence of steps to a general-purpose programming language. Loops, dynamic graph mutation, arbitrary inline shell, and unrestricted scripting increase expressiveness, but they also complicate validation, resumability, retry semantics, security review, portability across executors, and static reasoning about dependencies.

The initial goal is a broadly useful automation layer, not a replacement programming language.

## Decision

The v0.1 workflow model is a directed acyclic graph of named Steps.

The DSL supports declared dependencies (`needs`), conditional execution (`if`), and independent branches that may run in parallel. Cycles and general loop constructs are excluded from v0.1.

Ordinary Steps invoke named Capabilities rather than arbitrary inline shell, JavaScript, or Python. When arbitrary code is genuinely required, the workflow must invoke an explicit Privileged Code Capability. This makes the stronger trust boundary visible in the definition and allows the system to route it only to an appropriate Executor.

The DSL must not bind workflow meaning to a particular Executor. Executor selection is an execution concern, not the semantic identity of the Step.

## Consequences

### Positive

- Workflow graphs can be validated before execution.
- Retry, resume, visualization, and dependency scheduling remain tractable.
- Ordinary workflow definitions remain portable across execution backends.
- Arbitrary code is isolated behind an explicit security boundary instead of being ambient power available to every Step.

### Negative

- Some iterative workloads require a purpose-built Capability, a sub-workflow pattern, or a later DSL extension.
- Users familiar with GitHub Actions cannot paste arbitrary `run:` blocks into ordinary Steps.
- Dynamic workflows are intentionally less expressive in v0.1.

## Rejected alternatives

- General loops and dynamic graph mutation in v0.1: too much execution-state complexity before the durable runtime semantics are established.
- Ambient `run:` on every Step: couples definitions to runner environments and makes the default security boundary too broad.
