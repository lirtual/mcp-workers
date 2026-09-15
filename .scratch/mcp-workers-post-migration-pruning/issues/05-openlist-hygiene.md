# 05 — OpenList documentation and repository convergence

**Status:** ready  
**Blocked by:** none

## Goal
Remove standalone-repository and stale-spec noise while keeping current Worker code and the separate production-cutover boundary clear.

## In scope
- Remove app-local `.github` workflow.
- Remove stale `SPEC.md` once current invariants are represented in README/CONTEXT.
- Consolidate redundant docs/ADRs.
- Update current docs to `workers_dev:true`, `preview_urls:false` and workers.dev Portal upstream policy.
- Normalize SOURCE provenance.

## Out of scope
- Do not replace or mutate the separately operating OpenList Tunnel/local production service.
- No tool/path/read-only/business-token behavior changes.

## Acceptance criteria
- [ ] No current doc claims `workers_dev=false`.
- [ ] Docs explicitly separate repository target state from production cutover.
- [ ] Nested CI/stale spec are removed.
- [ ] OpenList `check` passes.

## Verification
PR-base root CI selects OpenList; no production calls required.
