# MCP Gateway

Purpose: one Clerk-verified resource per independent ChatGPT MCP connection, with a single machine identity to the existing Cloudflare MCP Portal. This Worker contains no MCP-specific business logic.

Source of truth: Portal registers upstream servers and tools; Clerk registers the matching full HTTPS MCP resource. New MCP onboarding requires configuration in those two existing products, **not a Gateway code change or automated onboarding workflow**. Access policies must separately permit the one Gateway service token to reach each approved upstream.

Ingress: `/mcp/{server_id}` and corresponding OAuth protected resource metadata. Never trust path alone: validate OAuth audience/Owner and upstream authorization. The initial implementation requires independent evidence that Clerk cannot issue an access token for an unregistered resource, and that removal/revocation blocks previously issued tokens before production exposure.

Runtime Secrets / Vars (production not yet configured): `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `CLERK_OWNER_USER_ID`, `CLERK_ISSUER`, `GATEWAY_ORIGIN`, `PORTAL_MCP_URL`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`. The last two values are the one Gateway Service Token pair, never separate upstream tokens.

High-risk MCPs and their business action gates remain outside the first pilot. No deployment, Portal/Access, Clerk, Secrets or plugin authorization is granted by a green PR CI. See [Spec #878](https://github.com/lirtual/mcp-workers/issues/878).
