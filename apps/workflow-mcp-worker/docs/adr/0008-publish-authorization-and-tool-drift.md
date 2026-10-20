---
status: accepted
date: 2026-10-20
---

# Publish activates an authorized workflow; meaningful tool drift requires renewed approval

When the single owner publishes a Workflow Definition, the system validates the definition and obtains the necessary external-operation authorization before the published version takes effect (**Q19=A**). An additional mandatory Enable step is not part of the lifecycle; a published workflow may be paused or disabled. For dynamically discovered MCP Servers, approval must not silently extend to newly introduced high-risk tools, widened authority or material contract changes: those require renewed authorization; ordinary compatible changes do not automatically require it (**Q20=A**). This reconciles Q11's explicit Publish with Q17's approval-at-activation requirement without introducing redundant publish/enable stages.

## Rejected alternatives

- Publish and Enable as two separately mandatory lifecycle operations.
- Automatically treating any new tools exposed by an already-authorized MCP Server as approved.

## Consequences

These decisions do **not** mandate a static MCP Server registry or hostname allowlist (Q7=B remains intact). The exact target/tool identity captured in an approval, safe/unsafe classification, handling of runtime-dynamic tool selection, what occurs when approval expires or an endpoint changes, disable/delete behavior for existing Runs, and the publication commit/authorization transaction still need explicit design. This ADR approves the *policy*, not a fully implemented security guarantee.

Design only: no source implementation, merge, deployment, credentials change, or Tickets.
