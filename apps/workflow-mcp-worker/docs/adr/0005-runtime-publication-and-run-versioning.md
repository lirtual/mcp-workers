---
status: accepted
date: 2026-10-20
---

# Runtime definitions publish from drafts and runs remain version-pinned

The single owner creates or changes Workflow Definitions through MCP as drafts, validates them, and explicitly publishes them before they can be triggered automatically (**Q11=A**). Every admitted Run is pinned to the definition version in effect at its start; later edits and publications affect new Runs only (**Q12=A**). Workflow definitions, published versions, and necessary definition metadata are stored in the existing D1 database (**Q13=A**), not a second KV/R2/external configuration store.

## Alternatives considered

- Automatically activate every saved edit.
- Let active Runs switch to the newest definition during execution.
- Introduce a separate storage system just for definitions.

## Consequences

This refines **ADR-0002**, confirming its runtime-authoring decision without restoring Git-only publication. The domain distinguishes a mutable **Draft**, an activated immutable **Published Version**, and a **Run** that retains its starting version. Round 4 **Q19=A** (ADR-0008) has since confirmed publication includes required authorization and activates the published version, without a second mandatory Enable step. Specific validation, atomic publish mechanics, version retention, detailed pause/disable behavior, schema details, and cross-deployment runner/engine compatibility remain **unsettled**. Workflow runtime state vs query projections remains the responsibility of Cloudflare Workflows and D1 as described in ADR-0004.

Design decision only. No implementation, migration, merge, deployment, credentials, or Tickets are authorized.
