# 03 — Instapaper repository hygiene

**Status:** ready  
**Blocked by:** none

## Goal
Keep Instapaper as the reference minimal Worker-only app and remove standalone-repository residue.

## In scope
- Remove app-local `.github` automation superseded by root CI.
- Normalize README/deployment language to current `workers_dev:true`, `preview_urls:false`, Portal-only policy.
- Keep credential bootstrap helper only if still invoked by package scripts/current docs.
- Normalize `SOURCE.md` to immutable provenance only.

## Out of scope
- No Instapaper API/tool behavior changes.
- No secret/bootstrap flow redesign.

## Acceptance criteria
- [ ] No nested GitHub workflow remains.
- [ ] Current docs contain no stale ingress/routing claims.
- [ ] SOURCE records repository/frozen commit/license provenance only.
- [ ] Instapaper `check` passes.
- [ ] No new scaffolding is added.

## Verification
PR-base root CI selects Instapaper and its package `check` succeeds.
