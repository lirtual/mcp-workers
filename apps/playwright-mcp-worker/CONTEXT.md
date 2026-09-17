# Domain Context

## MCP Identity
The client identity is handled at the Worker ingress boundary. `/mcp` requires the monorepo's shared `@mcp-workers/portal-auth` check with the dedicated `MCP_ACCESS_TOKEN` machine credential before any Playwright MCP handling. `/health` may remain unauthenticated.

## Browser Runtime
Browser automation is provided by Cloudflare Browser Run through a `BROWSER` binding and the official `@cloudflare/playwright-mcp` package. The exported `PlaywrightMCP` Durable Object is an upstream-required runtime component and is an intentional exception to the monorepo's preference for stateless MCP workers.

## MCP Transport
V1 exposes Streamable HTTP only at `/mcp`. Legacy SSE routes are not exposed unless a concrete client compatibility requirement appears later.

## Tool Mode
V1 uses snapshot mode by default. Vision mode is disabled. Keep the official default capability set initially rather than maintaining a local fork of the tool registry; capability reduction can be justified later from observed use.

## Persistence
V1 adds no R2, KV, D1, cookie-profile store, or custom browser-session persistence. Durable Object state exists only as required by the official Playwright MCP/McpAgent runtime.

## Version Policy
Pin `@cloudflare/playwright-mcp` to an exact installable official npm version; do not use a caret range. Cloudflare documentation and npm metadata currently disagree on the displayed version, so implementation must verify the registry before changing the pin. As of the architecture review on 2026-09-17, npm publishes `0.0.5` while Cloudflare documentation labels the current Playwright MCP as `v1.1.1`.

## CI and Verification
Repository CI performs deterministic local checks only: type checking, tests, and Wrangler deploy dry-run. CI must not consume remote Browser Run quota. Real browser verification is a post-deploy smoke test using an authenticated `/mcp` request and a minimal navigation/snapshot flow.

## Invariants
- The app lives at `apps/playwright-mcp-worker` and follows the existing pnpm workspace and CI conventions.
- `/mcp` is never intentionally exposed unauthenticated on a public deployment.
- The inbound `MCP_ACCESS_TOKEN` is consumed before Playwright MCP handling and must not be forwarded downstream.
- Browser Run uses the configured Cloudflare `BROWSER` binding; no arbitrary browser endpoint is accepted from callers.
- `nodejs_compat`, the Browser Run binding, the Durable Object binding, and the initial SQLite migration are configuration-as-code in `wrangler.jsonc`.
- V1 optimizes for the Workers Free plan and avoids background or CI activity that consumes Browser Run minutes.
- Sensitive credentials, page form values, cookies, and browser session material must not be intentionally logged.
