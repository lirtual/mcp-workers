---
status: accepted
date: 2026-10-20
---

# Workflow definitions are authored and published at runtime

Workflow MCP allows its authenticated owner to create, edit, and publish declarative YAML/JSON Workflow Definitions directly through MCP. Definitions are held by the runtime system rather than requiring Git commits, pull requests, or redeployments before the owner can publish a change. This follows Round 2 decision **Q5=B** and rejects Git-as-the-only-publication-source (**Q5=A**) because an AI/MCP-first workflow product should support direct management.

## Considered alternatives

- Git-backed, reviewed configuration files published only with deployments.
- Runtime-managed definition creation, editing, and publishing through MCP (**accepted**).

## Consequences

The historical 2026-09-18 v0.1 specification excluded runtime workflow authoring and editing. That exclusion is superseded by Q5=B. Round 3 **Q11=A, Q12=A, Q13=A** (ADR-0005) subsequently established draft-first publication, version-pinned Runs and D1 definition/version metadata. The exact validation contract, publishing transaction, deletion/disable semantics, migration support, and MCP tool names remain **unsettled**. This ADR must not be read as allowing immediate activation of every edit.
