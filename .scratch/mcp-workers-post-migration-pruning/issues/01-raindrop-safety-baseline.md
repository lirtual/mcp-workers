# 01 — Lock Raindrop pruning safety baseline

**Status:** ready  
**Blocked by:** none

## Goal
Lock the current Raindrop MCP capability surface before structural pruning so later cleanup cannot silently drop tools.

## In scope
- Add an exact-set regression assertion for the current 17 MCP tool names through the existing public `RaindropMCPService.listTools()` seam.
- Require `diagnostics` to remain in the set.
- Ensure the regression is part of `test:local` / package `check`.

## Out of scope
- No tool behavior, schema, runtime, package, dependency, or production changes.
- No live mutation calls.

## Acceptance criteria
- [ ] A deterministic test asserts the exact 17-tool name set, not only count/non-empty.
- [ ] `diagnostics` is explicitly covered.
- [ ] Existing Raindrop `check` passes.
- [ ] Diff is limited to tests/test configuration needed for the safety baseline.

## Verification
Run Raindrop package `check` through PR-base root CI.
