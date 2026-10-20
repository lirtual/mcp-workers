---
status: accepted
date: 2026-10-20
---

# Compile a fixed execution plan on Publish and stop on incompatible MCP schema drift

Workflow MCP validates, normalizes and compiles a Workflow Definition into an **immutable executable plan before Publish** (**Q45=A**). Every Run uses the published plan pinned at admission, not the latest mutable YAML/JSON interpreted afresh on each invocation. When a remote MCP Tool's effective schema becomes incompatible with the plan, execution **must stop at that call and report a contract error**; it must not let AI rewrite an active plan, silently remap arguments, or expand authorization (**Q46=A**).

## Rejected alternatives

- Interpret the latest editable DSL for every Run, so changes could alter a running execution.
- Repair incompatible tool arguments or business logic autonomously during a Run.

## Consequences and pending technical choices

This refines Q12 (Run-pinned versions), Q20/Q28 (tool/target/scope grants), Q38 (atomic Publish), and Q40 (restricted typed expressions). The plan must retain enough canonical definition and validated capability information to detect incompatible drift, while preserving Q7=B's ability to discover arbitrary safe MCP Servers without preregistration. The exact intermediate representation, deterministic Cloudflare Workflows step naming/branch replay, schema comparison and canonical hash algorithm, approval fingerprint, plan persistence and compatibility gate are **technical-spec proposals**, not owner-confirmed implementations. A compatible schema change may be tolerated only inside already-approved authority; an incompatible one is not an invitation for transparent AI repair.

Design only; no code, schema migration, CI changes, deployment, merge, credentials or Tickets.
