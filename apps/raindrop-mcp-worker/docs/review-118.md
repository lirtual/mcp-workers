# #118 two-axis pre-merge review — 2026-09-20

**Status: open findings; NOT an approval or permission to merge/deploy.**
Fixed source baseline: `93ff4f343c029aabf1a5a3a56056d0342760037e`;
reviewed PR branch through `56d7103c5cd88d4397566c4c42e66eef8828bddd`.
Sources: [spec #110](https://github.com/lirtual/mcp-workers/issues/110),
[ticket #118](https://github.com/lirtual/mcp-workers/issues/118),
`CONTEXT.md` and `docs/adr/0001-replace-legacy-tool-contract.md`.
No repository-wide `CODING_STANDARDS.md` / `CONTRIBUTING.md` was present.
This is a manual two-axis review, **not** a claim of separate parallel reviewer or live-account validation.

## Standards axis — architecture and code quality

- **Open — generated boundary undermined by `as any`.**
  `src/services/raindrop.service.ts:255–259` and other v3 calls bypass
  `openapi-fetch<paths>` typing, so the generated definition cannot catch a
  wrong HTTP path or method. Resolve while pruning and regenerating the YAML.
  Do not declare OpenAPI/type alignment until this is done.
- **Open — request body preflight deadline.**
  `src/services/execution-budget.ts:125–132` bounds the request-body size
  before starting the outbound timeout; a stalled source stream is not itself
  protected by that timer. The normal tool JSON body is finite, but the
  specified 20-second wall budget should also apply to preflight reads.
  Add a bounded abort and a no-submit test before final approval.
- **Addressed in this branch — duplicate v2 source.**
  Removed obsolete public tool modules, historical tests and service methods.
  `src/tools/index.ts` now enumerates the 26 v3 actions, with no v2 aliases.
- **Addressed in this branch — response semantics.**
  Explicit HTTP 4xx and `result:false` write replies are now classified as
  `UPSTREAM_REJECTED` / `failed`, distinct from unknown (5xx, 429,
  transport ambiguity). Error envelopes include explicit target IDs/scope;
  a single batch request does not manufacture per-ID or multi-request status.
  Relevant fixtures: `tests/v3_mutation_contract.test.ts`.

## Spec axis — #110 / #118 compliance

- **Blocking — active OpenAPI incomplete.**
  `raindrop-complete.yaml:72` still contains an obsolete
  `/collections/{parentId}/childrens` route. The active
  `/collections/childrens` and `/collection/-99` routes are absent; the
  `/tags` key lacks global PUT/DELETE, with historical `/tags/0` still in
  the generated source. See [route-by-route audit](./openapi-audit.md).
  YAML and the committed generated `src/types/raindrop.schema.d.ts`
  must be updated **together** and checked deterministically.
- **Pending — isolated live acceptance (#119).**
  The duplicate deletion gate and moving a collection to root
  (`parent=null`) remain disabled until documented disposable-account
  evidence. This is correct fail-closed behavior, not a passing live test.
- **Offline contract checked previously** for 26 tool discovery,
  input/output schemas, MCP transport, strict resource URIs, bounded
  reads/writes, and Wrangler dry-run. Any new code requires its own
  successful CI result; prior green runs are not transferable to later SHAs.

## Exit criteria

1. Constrain YAML and regenerate types with `pnpm run generate:schema`;
   ensure `check:schema` passes from a clean checkout and remove needed
   `as any` only when the generated signatures agree with official docs.
2. Close the preflight abort finding with a focused test.
3. Run application check, exact 26-tool MCP tests, and a fresh two-axis pass
   pinned to the final commit; do not use this preliminary note as approval.
4. Run #119 only against a disposable account and explicitly authorized
   test objects; do not infer production readiness from dry-run CI.
