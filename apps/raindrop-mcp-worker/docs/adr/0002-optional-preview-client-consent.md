# ADR-0002 — Optional destructive-action preview; approval belongs to client

Status: **Accepted; exact tool names pending**. Date: 2026-10-13.
Decision input: cross-Worker grilling Q3=A, Q5=A and Q8=A.
Related: [cross-Worker approval ADR](../../../../docs/tool-authorization/adr/0001-delegate-tool-approval-to-client.md).

## Context

Cleanup operations need trustworthy descriptions of irreversible impact, but the current Worker implements its own confirmation flow for actions such as `empty_trash` and `cleanup_collections` using `confirm: true`. Duplicate removal uses `dryRun` defaulting to true. The user wants the client (e.g. ChatGPT) to own interactive approval rather than requiring a second Worker-specific confirmation step.

A preview is useful domain functionality. It is not a security permission, not a lock, and not proof that data will remain unchanged between preview and execution.

## Decision

1. Preserve **optional, non-mutating preview** for destructive cleanup where meaningful. Requesting an actual cleanup need not first invoke preview.
2. Remove compulsory `confirm: true` / repeat-the-call approval gates from the Worker tool protocol. Client UX and client policy own user-facing confirmation.
3. **Q8=A:** Implement preview and execute as **separate MCP tool contracts** (distinct names and schemas), not as one overloaded tool with a `mode` or `confirm`/`dryRun` flag. Preview is explicitly read-only; execution is explicitly mutation-capable/destructive. The preview tool is optional and is not a prerequisite for executing.
4. Retain official upstream API semantics, batch scope limits, conservative duplicate detection, partial-outcome reporting, and no blind retry when the result of a write is unknown.
5. Avoid any change in which a legacy invocation that used to return a preview now silently mutates data. Decide the exact replacement tool names and legacy-name migration in Q11. Reuse current upstream service operations; avoid building a second approval service or new stateful preview token.
6. No change to production or current tool behavior is authorized by this document.

## Consequences

- Positive: no redundant second permission prompt or forced preview before legitimate client-approved cleanup.
- Positive: preview remains available for an agent that wants to inspect likely impact.
- Cost: a connected client may submit a destructive call without displaying a user prompt. Risk annotations are advisory and cannot compel particular approval UI.
- A preview cannot guarantee the exact affected set; results can change between preview and execution.

## Relationship to existing design

The prior `CONTEXT.md` description of cleanup as “preview-first” remains descriptive of the currently deployed tool contract. This ADR changes the target behavior to **preview-optional** after implementation and release. It does not overturn the existing official-resource/action tool contracts in ADR-0001.

## Not authorized

No production data cleanup, Worker deployment, credential update, or destructive live testing.
