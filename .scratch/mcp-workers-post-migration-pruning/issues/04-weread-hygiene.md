# 04 — WeRead documentation and repository convergence

**Status:** ready  
**Blocked by:** none

## Goal
Make README/CONTEXT the authoritative current WeRead contract and remove migration-era repository noise.

## In scope
- Remove app-local `.github` workflow.
- Remove `IMPLEMENTATION.md` after merging any unique current facts.
- Remove superseded `docs/spec.md` Service Binding contract.
- Review ADRs: preserve only durable non-obvious rationale; consolidate/remove superseded/redundant ADRs.
- Normalize SOURCE provenance.

## Out of scope
- Do not debug `WEREAD_UPSTREAM_ERROR`.
- Do not change 10-tool behavior, upstream API, credentials, or Portal auth.

## Acceptance criteria
- [ ] Current docs describe Portal-only workers.dev runtime and no current Service Binding/Gateway contract.
- [ ] Domain terminology worth retaining remains available.
- [ ] Nested CI and superseded docs are gone.
- [ ] WeRead `check` passes.

## Verification
PR-base root CI executes WeRead typecheck/tests/lint/Wrangler dry-run.
