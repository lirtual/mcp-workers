# ADR-0003 — Execute destructive Raindrop cleanup directly under existing tool names

Status: **Accepted architectural decision; implementation, client refresh, and production release pending**. Date: 2026-10-13.
Operator decision: grilling round 5 **Q14=B**, with the explicit additional constraint **remove optional preview entirely**. Earlier Q5=A and Q8=A are superseded; Q11 one-call execution remains in force.
Supersedes the target preview design in [ADR-0002](./0002-optional-preview-client-consent.md); historical source remains for decision traceability.

## Context

The currently implemented Raindrop cleanup tools have the following public names and behavior:

- `empty_trash`: omitted or false `confirm` only returns the number of trash items; `confirm:true` performs deletion.
- `cleanup_collections`: omitted or false `confirm` returns a preview/prompt; `confirm:true` performs cleanup.
- `remove_duplicates`: omitted `dryRun` defaults to true and reports duplicates; `dryRun:false` removes duplicates.

The operator explicitly prefers a personal, simple client-mediated permission model: one call to an existing tool performs the requested destructive operation. No optional preview, no Worker-specific confirmation flag, no extra second invocation, and no new preview tool.

## Decision

1. **Keep existing tool names**, including `empty_trash`, `cleanup_collections`, and `remove_duplicates`. Each invocation of these named destructive operations is **execution**, not preview.
2. Remove the `confirm` and `dryRun` preview/confirmation parameters from those tool schemas and handlers. Do **not** register separate `preview_*` or `execute_*` aliases. Delete any instructions that tell the client to preview and re-call to approve.
3. Distinguish client-owned human approval from Worker operation safeguards. Expose truthful destructive/non-read-only metadata and precise descriptions. Preserve authentication, upstream Raindrop token requirements, request validation, explicit supported operation scope, bounded batch behavior, partial/unknown-result reporting, and prohibition of blind retry after uncertain writes.
4. This is an **intentional semantic breaking change even though tool names do not change**. A previously valid `empty_trash` call with no parameters that formerly displayed a count will now empty the trash. `remove_duplicates` with omitted `dryRun` will now delete duplicates. Do not misrepresent name continuity as backward compatibility.
5. Before any separately approved deployment, update client-facing tool contracts, tests, and release notes; verify real ChatGPT tool re-discovery/reconnection and the new destructive metadata. Do not claim an unrefreshed client is safe. Exact operator-side client-refresh procedure is a next-round choice (Q18).
6. **No mandatory second confirmation** is reintroduced on the Worker. ChatGPT and other clients may have different approval UX or may call without a prompt. A bearer-holder with the upstream authority can perform the operation.
7. Real data cleanup, tool-call tests against a live Raindrop account, deployment, credential updates and production activation require separate authorization; this ADR does none of them.

## Consequences

**Positive:** no dual preview/execute interface, no `confirm`/`dryRun` approval state, and one direct call per requested cleanup operation. Fewer tool definitions and fewer confusing client parameter defaults.

**Negative:** behavior of old calls changes from harmless preview to irreversible action. An outdated tool cache, a mistaken agent decision, or an over-authorized client can cause unintended deletion. Removing the Worker prompt does not guarantee that ChatGPT displays an approval. Preview reports are no longer available through these cleanup tools.

**Trade-off:** Retain established conservative duplicate-selection rules and partial-result/error safeguards unless independently decided to change them; suppressing preview alone must not broaden the mutation scope.

## Explicitly superseded

- [ADR-0002](./0002-optional-preview-client-consent.md) previously approved an optional separate read-only preview tool. Q14=B overrides this.
- The historical `apps/raindrop-mcp-worker/CONTEXT.md` preview-first language now describes only pre-migration behavior, not the target contract.

## Open implementation/acceptance frontier

- Q17: Confirm existing conservative selection, skipping and partial-result protections for broad cleanup (including duplicates) remain.
- Q18: Define a mandatory client re-discovery/checkpoint for a same-name but different-side-effect release.
