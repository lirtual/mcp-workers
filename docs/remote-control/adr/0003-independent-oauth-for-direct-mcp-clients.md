# ADR-0003 — Independent OAuth for direct remote MCP clients

Status: accepted. Date: 2026-10-12. Decision input: Round 1 F2=A.

## Context

The existing `mcp-workers` repository operates MCP applications that share a Portal-oriented ingress pattern and a `MCP_ACCESS_TOKEN` convention. Remote Control MCP can invoke local development commands, so reusing the same static shared authentication credential creates unnecessary cross-application privilege exposure. The product also needs to be connectable directly by compatible remote MCP clients.

## Decision

- Expose a directly connectable remote MCP resource guarded by **independent OAuth**, with resource-scoped client authorization.
- Keep its credentials and authorization domain separate from the shared `MCP_ACCESS_TOKEN` used by existing MCP applications. Their tokens are not interchangeable with Remote Control MCP grants.
- Client authorization and device-side authorization are distinct: do not forward client OAuth access tokens to the Linux device, and do not treat successful OAuth as permission to bypass local tool/argument policy.
- The first release is single-user; account administration, a multi-tenant identity database and a bespoke fleet-pairing platform are not product requirements.

## Consequences and trade-offs

- Positive: supports standards-based direct external MCP clients and avoids coupling privileged host access to a token shared with less-privileged services.
- Positive: preserves a clear revocation and resource boundary.
- Cost: compliant OAuth discovery, login/consent, redirect safety, audience/scope validation and real-client end-to-end acceptance are required.
- **Subsequent accepted decision:** [ADR-0010](./0010-single-worker-oauth-and-mcp.md) selects a combined OAuth authorization and MCP resource **in one Cloudflare Worker**. The exact user identity provider, OAuth framework/version, token storage and client registration/ChatGPT compatibility remain unresolved.
- A future Portal connection, if added, must satisfy this product's independent client authorization; it cannot implicitly bypass OAuth and local checks.
- No actual authentication endpoint, secret or deployment is approved by this ADR.

## Rejected option

Sole reliance on existing MCP Portal and reuse of its shared ingress token to grant remote host control.
