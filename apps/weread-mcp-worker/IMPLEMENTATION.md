# Implementation Report

## Implemented

- Cloudflare stateless MCP entrypoint with `createMcpHandler()`
- 10 read-only WeRead domain tools
- Tencent Agent API allowlist
- fixed `skill_version = 1.0.4`
- flat upstream request body
- fail-closed `upgrade_info`
- endpoint-specific pagination/continuation
- 10-second timeout
- one retry for transient network failures and 502/503/504
- no retry for 429/auth/validation/upgrade errors
- stable MCP-facing error vocabulary
- no persistence or caching
- Portal-only Worker ingress using independent `MCP_ACCESS_TOKEN`
- shared `@mcp-workers/portal-auth` boundary that strips the inbound bearer before MCP handling
- separate `WEREAD_API_KEY` for Tencent upstream authentication
- browser Origin rejected by default; Origin-less service-to-service requests allowed
- domain context and ADRs

## Verification

The monorepo validation uses Node 24 and pnpm 10.17.1. Current checks cover:

1. `@mcp-workers/portal-auth` strict TypeScript typecheck and request-boundary tests.
2. WeRead TypeScript typecheck, dependency-free core protocol tests and MCP tests.
3. ESLint.
4. Wrangler dry-run through the workspace dependency and package exports.
5. frozen `pnpm-lock.yaml` installation without lockfile mutation.

The core WeRead tests cover:

- flat request body and skill version
- API/skill-version override resistance
- upgrade fail-closed behavior
- 429 no-retry behavior and Retry-After preservation
- one retry for 503
- bookshelf visible-item count semantics
- notebook total-note calculation and `lastSort`
- nested search `searchIdx → maxIdx`
- personal notes = highlights + thoughts without fabricated bookmarks
- public-review `reviewsHasMore` + `maxIdx` + `synckey`

The Portal-auth tests cover:

- missing configuration fails closed
- missing or incorrect bearer is rejected
- invalid browser Origin is rejected
- Origin-less server requests are allowed
- inbound `Authorization` is removed after authentication
- MCP protocol headers and the request body are preserved

Production deployment remains a separate Cloudflare Builds/Portal step. Before switching a live Worker, configure matching `MCP_ACCESS_TOKEN` values on the Worker and Portal, keep `WEREAD_API_KEY` separate, and validate Portal discovery plus one explicitly chosen read-only tool call.
