# 08 — Raindrop non-runtime repository pruning

**Status:** blocked  
**Blocked by:** 01

## Goal
Remove clearly non-runtime standalone-repository baggage before changing runtime/package modes.

## In scope
- Remove nested CI/release/issue automation, IDE/agent/scratch/conductor metadata, generated TypeDoc output/assets, stale implementation/refactor reports and other files with no current Worker/verification/deploy/legal/provenance responsibility.
- Normalize Raindrop SOURCE to immutable provenance.
- Keep runtime/package/entrypoints unchanged in this ticket.

## Out of scope
- Do not remove Node HTTP/STDIO/Bun entrypoints or dependencies yet.
- No tool behavior changes.

## Acceptance criteria
- [ ] Removed files are not referenced by active scripts/CI/docs.
- [ ] SOURCE no longer claims mutable Worker routing/identity.
- [ ] Exact 17-tool baseline remains green.
- [ ] Raindrop `check` passes.

## Verification
Repository reference scan plus PR-base Raindrop `check`.
