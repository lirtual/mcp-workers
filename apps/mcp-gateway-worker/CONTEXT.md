# MCP Gateway

Purpose: one Clerk-verified resource per independent ChatGPT MCP connection, with a single machine identity to the existing Cloudflare MCP Portal. This Worker contains no MCP-specific business logic.

Canonical production origin: `https://mcp-gateway.lirtual.dpdns.org` (one Custom Domain, no legacy-host compatibility). OAuth Resources use this origin plus `/mcp/{server_id}`. 

Source of truth: Portal registers upstream servers and tools; Clerk registers the matching full HTTPS MCP resource. New MCP onboarding requires configuration in those two existing products, **not a Gateway code change or automated onboarding workflow**. Access policies must separately permit the one Gateway service token to reach each approved upstream.

Ingress: `/mcp/{server_id}` and corresponding OAuth protected resource metadata. Never trust path alone: validate OAuth audience/Owner and upstream authorization. The initial implementation requires independent evidence that Clerk cannot issue an access token for an unregistered resource, and that removal/revocation blocks previously issued tokens before production exposure.

Runtime Secrets / Vars (configured for production): `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `CLERK_OWNER_USER_ID`, `CLERK_ISSUER`, `GATEWAY_ORIGIN`, `PORTAL_MCP_URL`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`. The last two values are the one Gateway Service Token pair, never separate upstream tokens.

High-risk MCPs and their business action gates remain outside the first pilot. No deployment, Portal/Access, Clerk, Secrets or plugin authorization is granted by a green PR CI. See [Spec #878](https://github.com/lirtual/mcp-workers/issues/878).

Execution-time tool admission: for `tools/call`, query the current Portal `tools/list` with the same Gateway machine identity (bounded pagination, JSON or SSE) before execution. Reject a tool absent from that live list, and fail closed on discovery errors. No second tool whitelist is maintained. Portal's own tool-disable enforcement at actual execution remains a separate production E2E gate.

Decommission safely: remove the selected upstream's Gateway Access admission or Portal mapping **before** deleting its Clerk Resource; then verify old access/refresh tokens cannot regain business access. Deleting a Clerk Resource alone is not proof of immediate access-token revocation. Keep Gateway Service Auth separate from the existing shared `WORKFLOWS` policy.


Protocol compatibility: retain existing 2025 MCP requests; for stateless MCP `2026-07-28`, validate per-request `_meta` and mirrored transport headers, answer `server/discover` with only the supported tools capability, and forward `tools/list`/`tools/call` through the existing Portal with matching headers. The internal execution-time tool lookup uses the same protocol version. Modern tool-list results are projected to the selected resource with private, zero-TTL caching. No additional per-server scopes, registry, or business logic. Real ChatGPT OAuth/tool discovery requires separate production E2E verification.
