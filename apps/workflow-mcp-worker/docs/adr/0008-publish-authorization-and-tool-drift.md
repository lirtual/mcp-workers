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

Round 5 **Q28=A** further fixes the authorization boundary to the **concrete target identity, tool and allowed operation scope**. A tool of the same name exposed by a different MCP Server does not inherit the original authorization. A dynamically discovered target need not have been registered beforehand (**Q7=B remains intact**). Round 6 **Q37=A** now requires a Run to **wait and request authorization** before first execution against a runtime-computed, previously unapproved target/tool/scope. Unattended execution must never silently increase authority; this authorization wait is a **Run condition**, not a request to preregister every MCP Server. The exact stable identity representation, approved-scope normalization, authorization-request/approval API, resumption, timeout, safe/unsafe classification, and handling of endpoint identity changes remain **open**. Round 5 **Q29=A** separately clarifies that pause/disable stops new triggers but does not cancel in-flight Runs (ADR-0012). The publication commit/authorization transaction remains unspecified. This ADR approves the *policy*, not a fully implemented security guarantee.

Design only: no source implementation, merge, deployment, credentials change, or Tickets.
