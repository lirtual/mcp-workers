# ADR-0002 — Optional destructive-action preview; approval belongs to client

Status: **Accepted in principle, interface shape pending**. Date: 2026-10-13.
Decision input: cross-Worker grilling Q3=A and Q5=A.
Related: [cross-Worker approval ADR](../../../../docs/tool-authorization/adr/0001-delegate-tool-approval-to-client.md).

## Context

Cleanup operations need trustworthy descriptions of irreversible impact, but the current Worker implements its own confirmation flow for actions such as `empty_trash` and `cleanup_collections` using `confirm: true`. Duplicate removal uses `dryRun` defaulting to true. The user wants the client (e.g. ChatGPT) to own interactive approval rather than requiring a second Worker-specific confirmation step.

A preview is useful domain functionality. It is not a security permission, not a lock, and not proof that data will remain unchanged between preview and execution.

## Decision

1. Preserve **optional, non-mutating preview** for destructive cleanup where meaningful. Requesting an actual cleanup need not first invoke preview.
2. Remove compulsory `confirm: true` / repeat-the-call approval gates from the Worker tool protocol. Client UX and client policy own user-facing confirmation.
3. Keep clear distinctions between preview and execute intent, explicit targets, and truthful risk annotations. Do not silently treat an omitted mode as authorization for an irreversible operation.
4. Retain official upstream API semantics, batch scope limits, conservative duplicate detection, partial-outcome reporting, and no blind retry when the result of a write is unknown.
5. The exact public interface for expressing preview versus execute remains unresolved in the next design round: a required mode on one tool versus separate operations. No change to production or current tool behavior is authorized by this document.

## Consequences

- Positive: no redundant second permission prompt or forced preview before legitimate client-approved cleanup.
- Positive: preview remains available for an agent that wants to inspect likely impact.
- Cost: a connected client may submit a destructive call without displaying a user prompt. Risk annotations are advisory and cannot compel particular approval UI.
- A preview cannot guarantee the exact affected set; results can change between preview and execution.

## Relationship to existing design

The prior `CONTEXT.md` description of cleanup as “preview-first” remains descriptive of the currently deployed tool contract. This ADR changes the target behavior to **preview-optional** after implementation and release. It does not overturn the existing official-resource/action tool contracts in ADR-0001.

## Not authorized

No production data cleanup, Worker deployment, credential update, or destructive live testing.
