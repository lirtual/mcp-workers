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

This refines **ADR-0002**, confirming its runtime-authoring decision without restoring Git-only publication. The domain distinguishes a mutable **Draft**, an activated immutable **Published Version**, and a **Run** that retains its starting version. Round 4 **Q19=A** (ADR-0008) has since confirmed publication includes required authorization and activates the published version, without a second mandatory Enable step. Round 5 **Q29=A** (ADR-0012) clarifies that pause/disable prevents new admissions but does not cancel existing Runs. **Q35=A** (ADR-0014) requires a pre-deployment compatibility check and blocks incompatible releases absent safe migration. Round 6 **Q38=A** now requires revision/concurrency checks for Draft edits and **atomic Publish**, rejecting stale writes and leaving the previous Published Version effective on validation/authorization failure. **Q39=A** requires archive/disable rather than destructive immediate deletion while nonterminal Runs still need pinned versions/history; safe reclamation comes after those Runs terminate and retention requirements are met. Round 7 **Q45=A** (ADR-0017) additionally requires Publish-time validation/normalization/compilation to an immutable execution plan, never interpreting a mutable definition anew for active Runs. **Q49=A** requires preserving every plan and essential reference needed by nonterminal Runs while enforcing finite retention for terminated ones. The precise compare-and-swap identifiers, compiler representation, validation errors, archive/delete API, post-terminal retention durations, schema details, and concrete compatibility checks remain **unsettled**. Workflow runtime state vs query projections remains the responsibility of Cloudflare Workflows and D1 as described in ADR-0004.

Design decision only. No implementation, migration, merge, deployment, credentials, or Tickets are authorized.
