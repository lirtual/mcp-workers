# 11 — Raindrop single OpenAPI type-generation path

**Status:** blocked  
**Blocked by:** 10

## Goal
Keep generated API types reproducible without maintaining duplicate generator/client stacks.

## In scope
- Identify the canonical OpenAPI source used to regenerate imported `raindrop.schema.d.ts`.
- Keep one `openapi-typescript`-style generation path if generated types remain imported.
- Remove duplicate OpenAPI specs/generator client output/config/dependencies that are not needed by runtime/tests.
- Prune corresponding root workspace overrides and regenerate lockfile only as required.

## Out of scope
- No API surface redesign or broad dependency upgrades.

## Acceptance criteria
- [ ] One documented command regenerates the retained schema type file from one canonical source.
- [ ] Runtime imports resolve against the retained generated types.
- [ ] Duplicate generator/client dependencies and overrides are gone.
- [ ] Frozen install and Raindrop `check` pass; exact 17-tool set unchanged.

## Verification
Run generation/diff determinism check, frozen install, root PR CI.
