# 10 — Retire Raindrop public release and registry engineering

**Status:** blocked  
**Blocked by:** 09

## Goal
Make the package metadata and documentation match a private monorepo Worker instead of a public multi-registry product.

## In scope
- Set package private and remove npm publish metadata/bin/files/engines no longer relevant.
- Remove MCPB/DXT, Smithery, Gemini/Vercel Skill/public registry manifests and release automation.
- Remove semantic-release/Husky/lint-staged/public docs scripts and dependencies that become unused.
- Rewrite README around Cloudflare Worker + MCP Portal only.

## Out of scope
- No tool behavior changes.
- OpenAPI generation cleanup belongs to 11.
- Logger/diagnostics runtime cleanup belongs to 12/13.

## Acceptance criteria
- [ ] Package no longer presents itself as public npm/STDIO/Bun/MCPB/Smithery product.
- [ ] Public release-only files/scripts/deps are gone.
- [ ] README documents only supported monorepo Worker operation plus source attribution.
- [ ] Exact 17-tool contract and `check` pass.

## Verification
Frozen workspace install after lock changes; PR-base root CI.
