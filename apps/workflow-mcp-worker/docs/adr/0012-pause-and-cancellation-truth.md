---
status: accepted
date: 2026-10-20
---

# Pausing a Workflow does not cancel its Runs; cancellation reports actual effects

Pausing or disabling a Workflow prevents **new trigger admissions** while leaving already admitted Runs to continue (**Q29=A**). Cancellation is a separate operation. When a Run is cancelled, Workflow MCP makes best-effort stop requests to external MCP tools or GitHub Actions, but only reports external work as **stopped when termination has been confirmed**. Unconfirmed execution or irreversible external effects are reported truthfully as uncertain rather than silently treated as rolled back (**Q33=A**). The separation prevents a routine pause from unexpectedly interrupting independent business operations.

## Rejected alternatives

- Automatically cancelling every active Run when a Workflow is paused/disabled.
- Treating a successful cancellation *request* as proof that external execution stopped or prior side effects were undone.

## Consequences

A pause affects future admissions, not the Published Version pinned to an existing Run (Q12=A). It does not grant permission for a previously stopped or unauthorized external call to proceed; all existing authorization/revocation constraints still apply. Round 6 **Q37=A** confirms that a **Run waiting for first-time target/tool authorization** is not the same as a **Paused Workflow**: the former waits for permission before external work, while the latter prevents new admission without stopping existing Runs. **Q44=A** additionally requires an explicit indeterminate outcome separate from failure/cancellation (ADR-0016). Exact Run/Step/Attempt cancellation state machine, authorization wait resumption and timeout, cancellation-before-dispatch races, waiting wake-up semantics, terminal output contracts, late callbacks, and cleanup deadlines remain **open**. No generic Saga rollback engine is implied.

Documentation-only agreement. No source implementation, merge, deploy, credential changes, or Tickets.
