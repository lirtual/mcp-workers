# ADR-0002: Authentication Boundaries

**Status:** Accepted

## Context
MCP client authentication and OpenList upstream authentication are different trust boundaries.

## Decision
Protect the MCP hostname with Cloudflare Access Managed OAuth. The Worker validates the `Cf-Access-Jwt-Assertion` JWT. OpenList requests use a separate low-privilege `OPENLIST_TOKEN` directly in the `Authorization` header. No OAuth server, KV token store, OpenList password login, or TOTP flow is implemented in the Worker.

## Consequences
The Worker has no authentication database. Operational setup requires Cloudflare Access plus rotation of the OpenList token if it expires or is revoked.
