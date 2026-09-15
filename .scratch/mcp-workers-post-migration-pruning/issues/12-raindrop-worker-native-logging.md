# 12 — Make Raindrop logging Worker-native

**Status:** blocked  
**Blocked by:** 11

## Goal
Remove production dependency on Node process logging/environment primitives.

## In scope
- Replace `process.stderr` logging with Worker-compatible `console.*` behavior.
- If log level remains configurable, inject/read it through Worker configuration rather than ambient Node `process.env` in production source.
- Preserve structured context and secret-safe logging behavior.
- Update focused tests.

## Out of scope
- Diagnostics schema/runtime metadata changes belong to 13.
- No business/tool behavior changes.

## Acceptance criteria
- [ ] Deployed Worker source path has no `process.stderr` dependency.
- [ ] Logger does not require Node ambient environment in production.
- [ ] Sensitive credentials are not logged.
- [ ] Exact 17-tool baseline and Raindrop `check` pass.

## Verification
Static source scan + focused logger tests + PR-base Raindrop check.
