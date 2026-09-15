# 14 — Final post-migration pruning acceptance

**Status:** blocked  
**Blocked by:** 02, 03, 04, 05, 06, 07, 13

## Goal
Prove the six-app monorepo is a maintainable active tree rather than a collection of frozen standalone repositories, without smuggling in production cutover.

## In scope
- Perform six-app retention review and repository-wide stale-reference scan.
- Ensure SOURCE files contain immutable provenance only.
- Run frozen workspace install and root CI-equivalent checks for all six apps; keep Database real PostgreSQL/MySQL integration.
- Use root MCP smoke runner only for approved live targets and explicitly selected safe/read-only tools when credentials/management access are available.
- Record any production/Portal items not independently verifiable as pending for the separate final cutover phase.
- After all acceptance evidence is complete, remove this pruning scratch implementation material while retaining durable current docs/spec conclusions where needed.

## Out of scope
- No production publisher switch, custom-domain change, old source-repo archive, or destructive user-data operation.

## Acceptance criteria
- [ ] Every active app file has runtime/verification/build-deploy/current-doc/legal-provenance responsibility.
- [ ] No nested standalone CI/release automation remains unless explicitly justified.
- [ ] No stale current docs contradict workers.dev/Portal policy or current auth architecture.
- [ ] Raindrop is Worker-only, exact 17-tool set intact, Worker-native logging/diagnostics in place.
- [ ] Frozen install, six app checks and Database integration all pass.
- [ ] Live smoke is either safely evidenced for authorized/live services or explicitly recorded as pending; never fabricated.
- [ ] Cleanup did not perform production cutover or mutate user data.

## Verification
Unified PR CI, repository search, package checks, optional safe live smoke, then code-review gate.
