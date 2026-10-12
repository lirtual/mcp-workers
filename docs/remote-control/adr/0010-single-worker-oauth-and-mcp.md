# ADR-0010 — Combined OAuth and MCP in one Cloudflare Worker

Status: accepted conditionally on using OAuth, but **authentication approach reopened for review** on 2026-10-12. Decision input: Round 3 H3=A. If the owner chooses the existing MCP Portal bearer-token model instead, this OAuth topology record must be superseded; no Portal decision has yet been recorded.

## Context

ADR-0003 requires a separately authorized remote MCP resource, independent of the token shared by the repository's other MCP applications. OAuth authorization and the MCP resource may be combined in one Worker or deployed as separate Workers. The official Cloudflare Workers OAuth Provider framework documents both approaches: split roles are its recommended shape for generality, while the combined `OAuthProvider` remains supported for a Worker that serves its own single resource.

This project targets one person, one remote MCP resource and one privately connected Linux host. Two independently deployed authentication/resource Workers would add coordination and failure points without a demonstrated first-release need.

## Decision

- **Use one Cloudflare Worker to host both the OAuth authorization endpoints and the Remote Control MCP resource endpoint.**
- Prefer a maintained, supported OAuth provider framework rather than writing the protocol implementation from scratch. The library's combined one-Worker `OAuthProvider` is the proposed implementation candidate, subject to compatibility validation and version pinning.
- Maintain **an independent user/client OAuth authorization boundary** for Remote Control MCP; never accept the existing shared `MCP_ACCESS_TOKEN` as remote execution authority.
- Preserve separate device/adapter authentication and device-side execution policy, including the isolated workspace and tool allowlist. Client OAuth tokens must not be forwarded to the device.
- Keep only the durable authorization/grant storage required by the selected provider, such as its `OAUTH_KV`; do not introduce a second Worker, D1, queue or custom authorization service merely to separate code roles.
- Ensure proper OAuth discovery, PKCE, authorization consent, resource audience/scope verification, client compatibility and revocation before enabling real host operations.

## Consequences and trade-offs

- Positive: fewer separately deployed Workers, bindings, secrets, deployments and points of failure for a personal single-resource product.
- Positive: retains independent client authorization without rebuilding OAuth.
- Trade-off: authorization and MCP ingress share a Worker deployment and failure domain; this is accepted for v1.
- The current upstream framework generally recommends split roles but explicitly supports a combined Worker. Selection of a specific provider version, identity provider, authorization claims/allowlist and grant lifetime remain open and must be verified against current documentation.
- This ADR does **not** authorize resource creation, application code, host access or deployment.

## Rejected option

An independent OAuth Authorization Server Worker plus MCP Resource Worker was rejected for v1 because it adds deployment/configuration work without a proven multi-resource need.
