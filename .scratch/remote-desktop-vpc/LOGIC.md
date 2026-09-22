# #178 VPC Service + Tunnel candidate — THROWAWAY, UNVERIFIED HOSTED LINK

**DO NOT MERGE/DEPLOY.** This branch starts from #177's local-only DO fixture so it can reuse its pinned, network-disabled Docker Desktop Commander 0.2.51 test. Draft PR will target #177's prototype branch rather than main. The test Worker is **NOT a complete MCP server, not OAuth, and not publicly enabled**.

## Decision question
Does a Workers VPC Service constrained to one private host:port plus Cloudflare Tunnel permit a smaller safe transport for one local Desktop Commander instance than the current custom DO/WebSocket bridge? See [#178](https://github.com/lirtual/mcp-workers/issues/178).

## What code does
- `http-adapter.mjs`: local loopback-only, distinct static test token, POST /invoke, exactly `sandbox_ping` / `sandbox_list_directory` with empty arguments, 8192-byte request and response cap, timeout, generic errors. The configured fixed root is not caller-supplied. For directory reads it reuses #177's Docker `--network none --read-only --user 1000:1000 --cap-drop ALL` stdio fixture. **Timeout of an injected stalled operation does not guarantee physical termination**; final OS-level executor deadline must be verified.
- `vpc-probe-worker.mjs`: disabled-by-default test-only private fetch shape using `env.PRIVATE_DEVICE.fetch("http://localhost/invoke", ...)`. Client token and adapter token are distinct but **neither is production OAuth**. It has no general MCP route and cannot be used by ChatGPT as-is.
- `wrangler.jsonc`: `workers_dev=false`, `preview_urls=false`, one `vpc_services` binding with an **invalid placeholder ID**. Do not deploy. The actual registered host/port determines routing, not the `fetch` URL.
- `test/adapter.test.mjs` and the new workflow: local mock of `PRIVATE_DEVICE.fetch()` to the real loopback adapter, plus pinned upstream stdio inside Docker; security negative tests. A green Actions run means **mocked binding + real local upstream**, not Cloudflare VPC or Windows proof.

## Account inspection (2026-09-23)
Read-only Cloudflare API: VPC Service list HTTP 200 with 0 services; two unrelated existing tunnels are down. No creation/binding access or active device proven. Avoid changing existing tunnels without checking ownership and impact.

## Official contract
- [Service config and permissions](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/): specific host/port, Connectivity Directory Admin to create and Bind to bind. HTTP origin leg is plaintext for `http` even though the tunnel leg is encrypted.
- [Tunnel](https://developers.cloudflare.com/workers-vpc/configuration/tunnel/): cloudflared >=2025.7.0, auto/quic, UDP 7844; no public Published Application necessary.
- [Getting started](https://developers.cloudflare.com/workers-vpc/get-started/): `localhost` target is documented when cloudflared and adapter run on same host/network namespace. Temporary test port must match Service port; stable single port is simpler for eventual deployment.
- [API](https://developers.cloudflare.com/workers-vpc/api/): registered target governs routing.
- [Pricing](https://developers.cloudflare.com/workers-vpc/platform/pricing/) and [limits](https://developers.cloudflare.com/workers-vpc/platform/limits/): free only during Open Beta, ordinary Workers request/compute limits apply, 1000 VPC Services/account.
- [Errors](https://developers.cloudflare.com/workers-vpc/reference/troubleshooting/): classify connection/destination failures and observe VPC metrics without leaking upstream details to MCP clients.

## Still blocked
1. Install and start cloudflared plus real restricted adapter on user's device; VPC Service and independent Tunnel ID with real host:port; capture `PRIVATE_DEVICE.fetch` via actual hosted Worker. No public route substitution.
2. OS restriction and secret rotation, offline/restart and real timeout, request and output bounded, cost/latency measurements; hard termination not proven.
3. OAuth discovery/refresh, current MCP protocol, actual Portal and ChatGPT Plus permissions. A CI-only bearer probe is insufficient.

Keep #173 / PR #177 available as DO/WebSocket fallback. No production workflow-mcp-worker configuration, D1, Secrets or worker modified.
