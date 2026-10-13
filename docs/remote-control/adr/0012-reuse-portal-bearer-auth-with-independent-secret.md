# ADR-0012 — Reuse MCP Portal Bearer authentication with an independent secret

Status: accepted. Date: 2026-10-12. Operator decision: K1=A ("confirm" in response to the explicit question about replacing OAuth with existing MCP Portal static Bearer plus a distinct token).

Supersedes [ADR-0003](./0003-independent-oauth-for-direct-mcp-clients.md) (independent direct-client OAuth) and [ADR-0010](./0010-single-worker-oauth-and-mcp.md) (combined OAuth authorization and MCP Worker). Those documents remain as historical records.

## Context

The existing `mcp-workers/main` already uses `packages/portal-auth/src/index.ts` with `authenticatePortalRequest`: it validates an `Authorization: Bearer` header against the Worker environment secret `MCP_ACCESS_TOKEN`, denies missing or incorrect tokens, and removes the header before passing the request to the MCP handler. It is **static Bearer authorization, not OAuth**. The Database, IMA and Raindrop MCP Workers intentionally share a token value.

The earlier Remote Control MCP proposal added GitHub OAuth, OAuth provider routes and a grant KV, despite a single-user deployment and existing MCP Portal integration. The operator explicitly opted to reuse the existing Portal pattern instead. Unlike the other MCP applications, Remote Control MCP can execute Linux file and Shell operations without container or project-root restriction (ADR-0011); this makes credential isolation particularly important.

## Decision

1. Use the existing **MCP Portal / `@mcp-workers/portal-auth` static Bearer authentication pattern** for v1; do not build GitHub OAuth login, an OAuth authorization server, OAuth consent/redirect flows or `OAUTH_KV`.
2. Use the existing environment secret **name** `MCP_ACCESS_TOKEN` but **a different strong, independently generated secret value** from the shared token used by the Database, IMA and Raindrop Workers. Remote Control credentials must not be accepted by those other Workers, or vice versa.
3. Fail closed when the token is missing or invalid. Do not expose an anonymous fallback for any remote execution tool.
4. Keep a **separate device/adapter credential** inside the private VPC Service + Tunnel path; the ingress Bearer token is not passed through to Desktop Commander. Apply device-side tool and argument validation, process ownership rules and operation receipts independently.
5. Token provisioning/rotation is operator-controlled and secrets must not be committed, printed or logged. A compromised ingress token is equivalent to granting access to the curated remote tools under the Linux Agent's ordinary OS user permissions.
6. **Compatibility gate:** before real write or Shell exposure, verify the *actual* MCP Portal / ChatGPT client path delivers the Bearer credential, that authenticated MCP initialization/tools/list/read-only call succeeds, and that unauthorized calls fail closed. A generic ChatGPT custom MCP connection must **not** be claimed to accept manually configured static Bearer headers without evidence. If the existing Portal path cannot convey the token, do not silently substitute OAuth or unauthenticated access; return to a new design decision.

## Consequences and trade-offs

- Positive: one MCP Worker ingress, no OAuth KV, GitHub OAuth app, login UI, callback management or new authorization component.
- Positive: reuses existing tested authentication middleware and secret-management conventions.
- Negative: a static Bearer token is a transferable secret; it has neither end-user scopes nor delegated OAuth consent, and access to independent third-party clients depends on their/Portal's header support.
- Negative: because the Agent runs without a container or project directory isolation, compromise or misuse of this token can affect files and secrets readable by the Agent's Linux user. The operator confirmed running the Agent as the **existing normal Linux login account**; no dedicated account is required. Its broader accessible secrets and privilege pathways must be reviewed before enabling writes/Shell (ADR-0011).
- The earlier requirement of direct **standards-based OAuth interoperability** is explicitly relinquished for v1. Do not present OAuth client compatibility as an accepted feature.
- The accepted VPC Service + private Tunnel design (ADR-0004), curated tool surface (ADR-0008), managed sessions (ADR-0009) and local receipts (ADR-0007) remain unchanged.

## Rejected alternative

A separate GitHub OAuth login, an OAuth provider Worker or a combined OAuth+MCP Worker with OAuth KV is unnecessary for the chosen Portal-bound personal deployment.

This ADR approves the **design choice only**, not implementation, secrets creation, Portal registration, production deployment or granting remote Shell execution.
