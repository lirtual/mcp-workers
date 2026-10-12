# ADR-0004 — VPC-only private device transport

Status: accepted. Date: 2026-10-12. Decision input: Round 1 F4=A.

## Context

The source research specification proposed a Cloudflare Worker reaching one Linux device over a VPC Service plus an outbound private Cloudflare Tunnel. Alternative patterns include a publicly published Tunnel application, a generic private network binding or a bespoke relay. They differ in how broadly a compromised component may reach the device and how much additional routing software is required.

## Decision

- Use **Cloudflare Workers VPC Service** scoped to a specific registered host/port, with an **outbound private Cloudflare Tunnel** to the Linux-side endpoint.
- Keep the device execution/adapter endpoint non-public. Do **not** publish it as a public Tunnel application or supply an automatic public fallback.
- Prefer an exact `vpc_services` binding rather than a broad `vpc_networks` reachability grant; clients may not choose a downstream host, port or arbitrary URL.
- Network privacy does not replace independent OAuth, device identity validation and device-side execution policy.
- Remain single-device for the first release; do not add a generic multi-device router, application-layer WebSocket relay, DO, D1, R2 or queue for routing merely in anticipation of scale.

## Consequences and trade-offs

- Positive: narrowly scoped private connectivity and less custom relay implementation.
- Positive: keeps a single accountable route to the initially supported Linux host.
- Cost: depends on Cloudflare's VPC Service and Tunnel availability, configuration and account eligibility; current beta/pricing terms must be checked before production.
- Cost: tunnel, host/port mapping and failure/timeout behavior need actual hosted validation, including no public fallback.
- **Unresolved design choice**: exact listener addressing, origin authentication and rotation, Tunnel lifecycle and incident recovery details.
- This network decision does not authorize production resource creation or expose host-control tools.

## Rejected options

Publicly published device adapter, broad private-network routing as the default, and a custom multi-hop relay service.
