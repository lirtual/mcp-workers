# ADR-0003 — Execute destructive Raindrop cleanup directly under existing tool names

Status: **Accepted for implementation; Q17=A and Q18=A confirmed, release pending**. Date: 2026-10-13.
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
5. **Q18=A:** Before any separately approved deployment/production acceptance, update contracts, tests and release notes. Refresh/reconnect the **real ChatGPT MCP integration**, verify that the actual `tools/list` descriptions and input schemas reflect one-call deletion and accurate destructive annotations, and record the client's observed approval behavior. A cached old schema/description blocks rollout. Do not execute destructive live cleanup as a metadata test, and do not assume that a user prompt always appears.
6. **No mandatory second confirmation** is reintroduced on the Worker. ChatGPT and other clients may have different approval UX or may call without a prompt. A bearer-holder with the upstream authority can perform the operation.
7. Real data cleanup, tool-call tests against a live Raindrop account, deployment, credential updates and production activation require separate authorization; this ADR does none of them.

## Consequences

**Positive:** no dual preview/execute interface, no `confirm`/`dryRun` approval state, and one direct call per requested cleanup operation. Fewer tool definitions and fewer confusing client parameter defaults.

**Negative:** behavior of old calls changes from harmless preview to irreversible action. An outdated tool cache, a mistaken agent decision, or an over-authorized client can cause unintended deletion. Removing the Worker prompt does not guarantee that ChatGPT displays an approval. Preview reports are no longer available through these cleanup tools.

**Q17=A safety invariant:** Preserve established conservative duplicate eligibility and annotated/highlighted-copy exclusions, batch and supported-operation scope limits, partial success/failure/unknown outcomes, fail-fast safeguards where present, and no blind replay on uncertain writes. Do not broaden deletion scope or redesign deduplication just because previews were removed.

## Explicitly superseded

- [ADR-0002](./0002-optional-preview-client-consent.md) previously approved an optional separate read-only preview tool. Q14=B overrides this.
- The historical `apps/raindrop-mcp-worker/CONTEXT.md` preview-first language now describes only pre-migration behavior, not the target contract.

## Implementation and acceptance checklist (not authorization)

- Unit and integration regression: each retained cleanup name executes once without `confirm`/`dryRun` and without a preview path; reject obsolete arguments rather than changing behavior based on hidden flags.
- Ensure each descriptor correctly declares `readOnlyHint:false`, `destructiveHint:true`, and valid input schema; use synthetic tests or a disposable dedicated test collection, not real user data.
- Preserve Q17=A conservative handling and verify partial/unknown results and no automatic replay under simulated failures.
- Q18=A: real ChatGPT discovery refresh and descriptive/risk-metadata acceptance are mandatory; old cached definitions block launch. Actual irreversible production calls require separate explicit owner permission.
- This design document does not authorize code merge, production deployment, Raindrop mutation, or a secret change.
