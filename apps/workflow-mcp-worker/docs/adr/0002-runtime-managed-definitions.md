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

The historical 2026-09-18 v0.1 specification excluded runtime workflow authoring and editing. That exclusion is superseded by Q5=B. Draft vs active states, definition versioning and snapshots, publication validation, destructive changes, authorization details, and behavior of already-running workflows are **not yet decided**; this ADR must not be read as a choice for immediate activation, a particular database schema, or a specific set of MCP tool names.
