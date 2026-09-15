# Portal-first authenticated Raindrop MCP on Cloudflare

## Problem

The current Cloudflare Worker exposes the Raindrop MCP endpoint directly while holding a private `RAINDROP_ACCESS_TOKEN`. ChatGPT connection attempts have also shown platform discovery/probe traffic that should not drive the MCP server into accumulating client-specific protocol hacks.

The desired result is a long-lived, standards-aligned remote MCP deployment that:

- authenticates the MCP client at the Cloudflare edge,
- keeps Raindrop API authentication entirely inside the Raindrop MCP Worker,
- prevents direct bypass of the authenticated front door,
- preserves compatibility with current MCP HTTP clients,
- avoids implementing and maintaining a bespoke OAuth authorization server unless the managed platform cannot satisfy the requirement,
- remains compatible with the Cloudflare Free plan where possible.

## Solution

Use a **Portal-first, Gateway-fallback** architecture.

Primary path:

`MCP client -> Cloudflare MCP Portal / Access Managed OAuth -> raindrop-mcp Worker -> Raindrop.io API`

Responsibilities are separated as follows:

- **Cloudflare MCP Portal / Access Managed OAuth** owns client-facing OAuth, discovery, and MCP front-door policy.
- **raindrop-mcp Worker** owns MCP tool execution and Raindrop API access through `RAINDROP_ACCESS_TOKEN`.
- **An origin authentication secret** protects the Worker `/mcp` endpoint from direct bypass and is injected only by the trusted Cloudflare front door.
- **cloudflare_gateway** is not in the default request path. It remains a fallback for MCP backends that require transforms, rewrites, or compatibility behavior that Portal cannot provide.

The Raindrop Test Token must never be reused as the MCP client credential or front-door OAuth credential.

## User Stories

1. As the owner, I want to connect ChatGPT or another standards-compatible MCP client through OAuth, so that my Raindrop MCP is not publicly callable without authentication.
2. As an MCP client, I want to discover and call the Raindrop MCP tools through a standards-compatible HTTP endpoint, so that tool listing and invocation work without client-specific server forks.
3. As the owner, I want the Raindrop API token to remain only in Worker secrets, so that clients and intermediary OAuth credentials never expose my Raindrop account credential.
4. As the owner, I want direct requests to the backend `/mcp` endpoint rejected unless they carry the trusted origin credential, so that the authenticated front door cannot be bypassed.
5. As the owner, I want the Worker health endpoint to remain usable for operational checks without exposing MCP tool access, so that deployments can be diagnosed safely.
6. As the owner, I want the Worker to fail closed when `RAINDROP_ACCESS_TOKEN` or the origin credential is missing, so that configuration mistakes do not create an unauthenticated service.
7. As an operator, I want authentication failures, MCP transport failures, and upstream Raindrop failures to be distinguishable in logs, so that incidents can be diagnosed without logging secrets.
8. As a maintainer, I want protocol handling delegated to the MCP SDK wherever possible, so that future MCP protocol changes do not require a growing set of ChatGPT-specific branches.
9. As a maintainer, I want the existing empty-probe compatibility shim treated as temporary compatibility behavior, so that it can be removed once the managed front door and current MCP clients no longer require it.
10. As the owner, I want `cloudflare_gateway` available only as an explicit fallback path, so that unusual MCP integrations can still use rewrites or special upstream authentication without making every MCP depend on bespoke gateway logic.
11. As a maintainer, I want automated tests at the public Worker HTTP/MCP seam, so that refactors of internal services do not require test rewrites.
12. As the owner, I want the deployment to avoid unnecessary stateful infrastructure in `raindrop-mcp`, so that D1, KV, Durable Objects, and Raindrop OAuth are not added for a single-user fixed-token deployment.

## Implementation Decisions

### 1. Front-door authentication

- Primary authentication is Cloudflare-managed OAuth at the MCP front door.
- Do not implement OAuth authorization-code, refresh-token, dynamic-client, or client-metadata persistence inside `raindrop-mcp`.
- Do not make `cloudflare_gateway` the default OAuth authority for this service.
- The user-facing MCP URL must be the authenticated Cloudflare front-door URL, not the raw Worker origin URL.

### 2. Worker origin authentication

Add a dedicated Worker secret, conceptually `MCP_ORIGIN_TOKEN`, whose only purpose is authenticating the trusted Cloudflare front door to the Worker.

For `/mcp`:

- Reject requests when the origin credential is missing or invalid.
- Validate the credential before invoking the MCP handler.
- Do not accept `RAINDROP_ACCESS_TOKEN` as an origin credential.
- Do not log either secret.

`/health` remains independently accessible for health checks and must not expose secrets or MCP capabilities.

### 3. Raindrop upstream authentication

- Keep `RAINDROP_ACCESS_TOKEN` as a Worker secret.
- `RaindropService` continues to use this token for calls to Raindrop.io.
- No Raindrop OAuth flow, token refresh store, D1, KV, or Durable Object is introduced in this scope.

### 4. Public-origin reduction

- Disable the default `workers.dev` route for the production Worker where deployment topology permits it.
- The backend custom domain may remain routable if required by MCP Portal, but `/mcp` must still require the origin credential.
- No security property may depend only on the origin URL being obscure.

### 5. MCP transport behavior

- Continue using the existing `@modelcontextprotocol/server` Web-standard handler.
- Real MCP requests must remain SDK-managed rather than being rewritten into a private protocol.
- Preserve the current empty `application/octet-stream` POST compatibility shim only while required by real client behavior.
- Mark the shim as temporary and cover it with an explicit regression test.
- Do not infer failure merely from the absence of legacy `initialize`; tests should verify observable MCP behavior such as discovery/tool listing/tool invocation supported by the installed SDK/client path.

### 6. CORS and headers

- Keep CORS behavior narrowly scoped to actual browser needs; server-to-server MCP correctness must not depend on permissive CORS.
- The origin credential header must be accepted from the configured Cloudflare front door but must not be reflected to clients.
- Client OAuth bearer tokens and the Raindrop API token remain separate credentials with separate trust boundaries.

### 7. `cloudflare_gateway` fallback boundary

Use `cloudflare_gateway` only when a backend requires capabilities not available in the managed Portal path, including examples such as:

- nonstandard path rewrites,
- custom request/response body transforms,
- unusual upstream authorization formats,
- protocol compatibility adaptation not handled by Portal.

If this fallback is used later, Gateway client authorization must be consumed at the Gateway and must not leak to the upstream MCP server; upstream authentication must remain a separate credential.

## Configuration Contract

Production requires these externally managed values:

- `RAINDROP_ACCESS_TOKEN`: Raindrop personal/Test Token used only by the Worker when calling Raindrop.io.
- `MCP_ORIGIN_TOKEN`: independent high-entropy shared secret used only between the trusted Cloudflare front door and the Worker origin.
- Cloudflare MCP Portal / Access configuration that points to the Worker MCP origin and injects the origin credential header.

Repository code must not contain real token values.

## Failure Behavior

- Missing `RAINDROP_ACCESS_TOKEN`: fail closed with a server configuration error before serving MCP work.
- Missing `MCP_ORIGIN_TOKEN`: fail closed for `/mcp`.
- Invalid/missing origin credential: return an authentication error without invoking the MCP service.
- Invalid MCP request: preserve MCP SDK transport/protocol error behavior.
- Raindrop API authentication failure: surface as an MCP tool/upstream error; never fall back to another credential.
- Cloudflare front-door OAuth failure: handled outside the Worker; the Worker must not attempt to emulate or repair the OAuth flow.

## Testing Decisions

Use the existing Vitest test suite and highest available public seams.

### Required automated coverage

1. Worker `/health` succeeds without the origin credential and exposes no secret material.
2. Worker `/mcp` rejects a request when `MCP_ORIGIN_TOKEN` is absent from the environment.
3. Worker `/mcp` rejects missing or incorrect origin credentials before MCP handler execution.
4. Worker `/mcp` accepts the correct origin credential and passes a valid MCP request to the existing handler.
5. Empty octet-stream compatibility probe returns the documented compatibility response only when origin authentication has already succeeded.
6. A normal JSON MCP request is not altered by the compatibility shim.
7. Missing `RAINDROP_ACCESS_TOKEN` fails closed.
8. Existing MCP integration tests continue to pass.
9. Type-check, lint, formatting check, and the full Vitest suite pass.

### Manual acceptance

1. Deploy the Worker with `workers.dev` disabled where supported by the chosen topology.
2. Configure the Cloudflare MCP Portal / Managed OAuth front door.
3. Configure the front door to inject the origin credential header to the Worker.
4. Confirm a direct request to the Worker MCP origin without the origin credential is rejected.
5. Connect ChatGPT through the front-door MCP URL and complete OAuth.
6. Confirm the client can enumerate Raindrop MCP tools.
7. Execute at least one read-only Raindrop tool successfully.
8. Execute a write-capable tool only after confirming the read-only path and verify the change in Raindrop.
9. Confirm Worker logs contain no OAuth bearer token, origin token, or Raindrop token.

## Out of Scope

- Implementing a new OAuth authorization server in `raindrop-mcp`.
- Moving the `feat/mcp-oauth` implementation from `cloudflare_gateway` into this repository.
- Raindrop multi-user OAuth.
- Per-user Raindrop credential storage.
- D1, KV, Durable Objects, or other persistence in `raindrop-mcp` for this feature.
- Replacing the MCP SDK with a custom MCP transport.
- ChatGPT-specific protocol forks beyond the already-observed narrowly scoped compatibility probe handling.
- Refactoring unrelated Raindrop tools or business logic.
- Making all existing MCP services migrate to MCP Portal as part of this issue.
- Deleting `cloudflare_gateway`; it remains an optional fallback component.

## Acceptance Criteria

- Client-facing access is authenticated by the managed Cloudflare front door.
- The raw `/mcp` Worker origin cannot be used without the independent origin credential.
- Raindrop API access continues to use only `RAINDROP_ACCESS_TOKEN`.
- ChatGPT can connect through the authenticated front door and successfully enumerate tools.
- At least one read-only tool works end to end.
- No new database or stateful storage is added to `raindrop-mcp`.
- No client-specific OAuth server is added to `raindrop-mcp`.
- Existing MCP/tool behavior remains regression-safe through the current test suite.

## Implementation Order

1. Add Worker origin-auth contract and tests.
2. Fail closed on missing secrets.
3. Disable/reduce direct production exposure (`workers.dev`) as topology permits.
4. Keep and test the temporary probe shim behind successful origin authentication.
5. Document Cloudflare MCP Portal / Managed OAuth setup and required secrets.
6. Deploy and validate direct-origin rejection.
7. Validate authenticated MCP discovery/tool listing through the front door.
8. Validate one read-only tool end to end, then one write path.
9. Reassess whether the compatibility shim can be removed after successful production connection.

## Ready-for-Agent Notes

The implementation agent must not redesign OAuth or introduce persistence. If Cloudflare MCP Portal cannot satisfy the documented front-door requirement in the actual account/runtime, stop at that integration boundary and use `cloudflare_gateway` only as the documented fallback rather than expanding `raindrop-mcp` into an OAuth server.
