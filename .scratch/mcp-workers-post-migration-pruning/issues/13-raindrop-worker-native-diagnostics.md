# 13 — Make Raindrop diagnostics Worker-native

**Status:** blocked  
**Blocked by:** 12

## Goal
Keep `diagnostics` as a real capability while reporting only meaningful Cloudflare Worker/runtime information.

## In scope
- Remove fabricated/Node-specific fields that depend on process version/platform/uptime/memory or Bun globals.
- Preserve tool name, purpose, server/protocol version, enabled-tool reporting and useful Raindrop library-health data.
- Remove now-unneeded Node/Bun ambient types/dependencies.
- Update diagnostics schema/tests.

## Out of scope
- Do not remove/rename `diagnostics`.
- No destructive live calls.

## Acceptance criteria
- [ ] `diagnostics` remains in exact 17-tool set.
- [ ] Production source path no longer uses Node lifecycle/environment/memory APIs or Bun globals for diagnostics.
- [ ] Diagnostics response validates against its updated schema and retains operationally useful fields.
- [ ] Frozen install and Raindrop `check` pass.

## Verification
Focused diagnostics contract tests + static scan + PR-base root CI.
