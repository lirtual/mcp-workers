# ADR-0001: Cloudflare Playwright MCP Runtime

**Status:** Accepted

## Context
The repository needs a general-purpose browser automation MCP server while preserving the existing `mcp-workers` conventions: one app per Worker, pnpm workspace integration, GitHub-connected Cloudflare deployment, configuration-as-code, shared Portal authentication, and minimal operational surface.

Cloudflare's official Playwright MCP implementation is designed for Workers + Browser Run and requires a Browser binding plus an `McpAgent` Durable Object with migration metadata. This is materially different from the stateless transport used by several existing apps, so the exception must be explicit rather than accidental.

Cloudflare's current documentation supports modern Streamable HTTP at `/mcp` and also shows legacy SSE compatibility routes. The repository does not currently need SSE for this app. Browser automation is high privilege, so unauthenticated public smoke deployment is not acceptable when the shared `portal-auth` package is already available.

The upstream version metadata is currently inconsistent: Cloudflare documentation calls the current Playwright MCP `v1.1.1`, while the public npm package `@cloudflare/playwright-mcp` currently exposes `0.0.5`. Therefore the architecture must define a pinning policy without encoding an unverified package version.

## Decision
- Implement the server in `apps/playwright-mcp-worker` inside this monorepo; do not create a separate repository.
- Use the official `@cloudflare/playwright-mcp` package and Cloudflare Browser Run rather than reimplementing the Playwright MCP protocol or browser tooling.
- Expose V1 only through Streamable HTTP at `/mcp`; do not expose `/sse` or `/sse/message` until a real compatibility requirement exists.
- Require `MCP_ACCESS_TOKEN` authentication from the first public deployment by reusing `@mcp-workers/portal-auth`. Keep `/health` public.
- Configure `BROWSER`, `MCP_OBJECT`, the `PlaywrightMCP` SQLite Durable Object migration, `nodejs_compat`, and the current compatible Worker date in `wrangler.jsonc`.
- Accept the upstream-required `McpAgent`/Durable Object runtime as a narrowly scoped exception to the repository's stateless preference. Do not add application-level persistence in V1.
- Use snapshot mode by default and leave Vision disabled.
- Start with the official default capability set. Do not maintain a local tool fork merely to remove `files` or `testing`; reduce capabilities later only if observed usage justifies it.
- Pin `@cloudflare/playwright-mcp` to an exact official npm version. At implementation time, verify the registry and lock the actually installable version; do not use a caret range and do not assume the documentation's display version is the npm package version.
- Keep CI quota-free: typecheck, tests, and `wrangler deploy --dry-run` only. Run one short authenticated Browser Run smoke test after deployment instead of on every commit.
- Add no R2, KV, D1, persistent browser profile, custom cookie store, hostname guardrail adapter, or other infrastructure in V1 unless an observed requirement proves it necessary.

## Consequences
The app stays consistent with `mcp-workers` operational patterns while using the stateful runtime Cloudflare's official Playwright MCP requires. The public attack surface is smaller than the official example because only `/mcp` is exposed and it is authenticated from day one.

V1 remains intentionally general-purpose and low-maintenance. It can navigate, inspect, and interact using the official tool surface without introducing a local fork. The trade-off is that per-destination browser restrictions and persistent authenticated browser profiles are deferred; those require separate design decisions if needed later.

Because CI does not start remote browsers, post-deploy verification is required before considering a release healthy. The minimum smoke sequence is MCP initialization/tool discovery followed by a short navigation to a harmless public page and an accessibility snapshot, with Browser Run usage checked afterward.
