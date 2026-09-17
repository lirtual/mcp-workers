# ADR 0019: Use explicit capability contracts and deterministic executor routing

- Status: Accepted
- Date: 2026-09-17

## Context

Workflow steps request semantic operations while multiple executors may be able to perform them. If routing is inferred dynamically from runtime heuristics, AI judgment, payload size guesses, or transient executor availability, two runs of the same Workflow Definition Version can acquire different execution semantics. Retry safety and side-effect classification also cannot be inferred reliably at dispatch time.

## Decision

Every executable Capability is registered with an explicit Capability Descriptor. The descriptor defines at minimum its input contract, output contract, side-effect classification, retry-safety semantics, allowed Executors, and default Executor.

Executor selection is deterministic for one Workflow Definition Version. Workflow authors may explicitly select another allowed Executor when the Capability permits it, but runtime orchestration does not make heuristic or model-driven routing decisions.

An Executor cannot perform a Capability unless that pairing is declared by the Capability contract.

## Consequences

### Positive

- Retry, timeout, and security policy can be validated before execution.
- One definition version has reproducible routing semantics.
- Adding executors does not silently move existing workloads.
- Capability metadata becomes the stable boundary between DSL and execution backends.

### Negative

- Capability registration requires deliberate metadata rather than accepting arbitrary operations dynamically.
- New executor/capability combinations require explicit compatibility declaration.

## Rejected alternatives

- Let an AI or heuristic choose the executor at runtime: flexible but non-reproducible and difficult to audit.
- Let executors self-advertise arbitrary capabilities without workflow-level contracts: weakens validation and retry/side-effect guarantees.
