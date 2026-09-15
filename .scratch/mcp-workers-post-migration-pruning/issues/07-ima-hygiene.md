# 07 — IMA repository and documentation pruning

**Status:** ready  
**Blocked by:** none

## Goal
Remove source-skill/reference and retired architecture baggage while keeping the current single-user Portal-only Worker contract intact.

## In scope
- Remove app-local `.github` workflow.
- Remove unused `original-skill/`, `companion-skill/`, superpower/historical design materials after reference/import checks.
- Remove obsolete changelog/history describing retired D1/per-user OAuth architecture.
- Consolidate duplicate deployment/Portal docs where practical without losing current operator guidance.
- Normalize SOURCE provenance.

## Out of scope
- No IMA tool behavior changes.
- No signed-download, SSRF, R2, secret, or business credential changes.

## Acceptance criteria
- [ ] No active tree carries unused skill package copies or retired D1/OAuth current guidance.
- [ ] Current signed-download and Portal-only docs remain accurate.
- [ ] License/provenance are preserved.
- [ ] IMA `check` passes with existing test contract.

## Verification
PR-base root CI selects IMA and all tests/typecheck/Wrangler dry-run pass.
