# 09 — Retire Raindrop Node HTTP / STDIO / Bun runtime modes

**Status:** blocked  
**Blocked by:** 08

## Goal
Contract Raindrop to the Cloudflare Worker runtime path while preserving its MCP capability contract.

## In scope
- Remove STDIO entrypoint and standalone Node/Express HTTP server entrypoint.
- Remove scripts/tests/types/dependencies used only by those retired runtime modes.
- Keep Worker `src/worker.ts` -> MCP service -> Raindrop service path.
- Preserve exact 17-tool set.

## Out of scope
- Public release/registry packaging cleanup belongs to ticket 10.
- Logger/diagnostics Worker-native behavior changes belong to tickets 12/13.

## Acceptance criteria
- [ ] No supported app entrypoint requires STDIO, Express, Bun, or Node HTTP server.
- [ ] Tests that only protect retired modes are removed, while Worker/service behavior remains covered.
- [ ] Exact tool-name test stays green.
- [ ] Raindrop `check` passes.

## Verification
PR-base Raindrop check including Wrangler dry-run.
