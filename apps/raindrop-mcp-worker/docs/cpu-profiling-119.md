# #119 — request-scoped MCP CPU profiling

Status: diagnostic plan only. This document is **not** measured stage-level CPU evidence, an optimization approval, or Free-plan acceptance. Issue: [#119](https://github.com/lirtual/mcp-workers/issues/119); implementation: [Draft PR #120](https://github.com/lirtual/mcp-workers/pull/120).

## Version-pinned native baseline

Cloudflare isolated script `raindrop-mcp-worker-v3-test`, deployment `850c9092-9a10-4492-90e4-72c56266c231`, version `fe61f8b7-e7bd-41a0-8671-31408cc57007`. Source workflow edit: `7518fb2e46a9b3418f1ae319811a8921253452c2`; correlate measurements by **deployed script version**, not SHA alone. Existing #119 comment contains the underlying event records.

| Labeled read-only operation | Native CPU ms | Samples above 10 ms |
| --- | --- | ---: |
| initialize | 38, 12, 8 | 2/3 |
| tools_list | 38, 13, 12 | 3/3 |
| diagnostics_local | 7, 5, 7 | 0/3 |
| diagnostics_upstream | 16, 9 | 1/2 |
| collection_list_1 | 15, 10 | 1/2 |
| raindrop_list_1 | 7, 9 | 0/2 |
| raindrop_list_50 | 15, 9 | 1/2 |

17 labeled requests, 8 above the published Free HTTP 10 ms CPU limit. Initial 38 ms samples **may not** be called cold starts without independent evidence. HTTP 200, zero runtime errors, and a `standard` usage-model field are not proof of Free entitlement or enforcement. Small n cannot establish p95/p99 or worst case.

## Exact source boundaries to examine

- `src/worker.ts`: authentication -> bounded ingress read -> new `Request` -> `createHandler(env).fetch(...)`.
- `src/services/raindropmcp.service.ts`: `buildToolConfigs(...)` runs once at module scope, **not** once per invocation. Each `RaindropMCPService` constructs its own upstream service and `McpServer`, registers 26 tools, static resources, resource handlers and prompt handlers.
- `src/services/raindrop.service.ts`: constructs a fresh `ExecutionBudget`, per-request caches, `openapi-fetch` client and middleware. Credentials stay request-scoped.
- SDK: account for its dispatch, schema/metadata conversion and `tools/list` response serialization separately when the profiler can attribute them. Do not assume synchronous `createMcpHandler` constructs the server: its factory callback may be invoked later during `.fetch()`.

## Phase A: local function-level CPU profile (no live account)

1. Pin the source commit and install the existing workspace using its lockfile. Run `pnpm --filter raindrop-mcp-worker dev` locally, with **synthetic** local-only MCP and upstream tokens, and open Wrangler DevTools (press `D`, then Profiler). Do not copy real tokens or personal payloads into profile exports.
2. Record separate profiles for authenticated `initialize`, `tools/list`, and local-only `tools/call` on `diagnostics` with `includeUpstream=false`. These require no Raindrop API calls. Add stubbed representative read responses only in a local test harness to investigate output processing without touching the account.
3. Record sampled self-time and total-time, call stacks, sample counts and source/version for the boundaries above. Compare repeated same-operation requests after startup with the first request; report both, without inventing a cold-start explanation.
4. Use a local harness to profile **fresh server construction alone** alongside complete ingress/SDK requests. Construction is a subset of the full path; never sum separately sampled medians as if they were additive.
5. If local profiling cannot attribute a section, mark it `Unresolved`. Do not substitute `performance.now()` deltas within continuous Worker CPU work: Workers timers advance on I/O. Node `process.cpuUsage()`, DevTools and wall time are diagnostics only, not the Free release gate.

Use the new **loopback-only** `scripts/profile-local-cpu.mjs` driver. It accepts only plain HTTP localhost / 127.0.0.1 / [::1], disables redirects, prints operation labels but no response contents, and makes no read or write calls to the Raindrop API. Use disposable **synthetic tokens** in a local untracked `.dev.vars` (not in the repository or profiler export), e.g. `MCP_ACCESS_TOKEN=local-mcp-profile-token` and `RAINDROP_ACCESS_TOKEN=synthetic-not-a-real-credential`. Ensure they match the driver’s local token. With Wrangler running on `127.0.0.1:8787`, record **separate** DevTools profiles for the following commands from the Worker package directory:

```bash
node scripts/profile-local-cpu.mjs initialize
node scripts/profile-local-cpu.mjs tools_list
node scripts/profile-local-cpu.mjs diagnostics_local
```

The driver defaults to 2 warmup calls and 10 samples per operation; change these using `RAINDROP_LOCAL_PROFILE_WARMUPS` and `RAINDROP_LOCAL_PROFILE_SAMPLES` (maximum 10 and 50). Logs are progress markers **not CPU times**. Fail any malformed response, JSON-RPC error, unexpected 26-tool count, or failed local diagnostics. Collect actual function-level CPU results from the DevTools profile only. These local samples do not establish Cloudflare native CPU compliance.

The existing `scripts/test-direct-mcp.mjs` deliberately refuses localhost in CPU mode; **do not weaken that isolated-host safety check** to obtain a local profile. Never run lifecycle suites or a destructive Raindrop operation for CPU investigation.

## Phase B: decision and release evidence

Only after an attributable hotspot is recorded: propose one minimal, reviewed modification. Keep mutable `McpServer`, transport, credentials, budgets, caches, and request-specific handlers isolated. Hoist only demonstrably immutable, secret-free metadata if a measured benefit and correct SDK behavior are established. Compare the exact new isolated deployment version against the pinned baseline using the existing read-only-only workflow, `x-raindrop-profile-op` / UTC windows, and native `$workers.cpuTimeMs`. Record per-operation raw values, sample counts, errors, and number over 10 ms; never treat missing CPU telemetry or a failed request as 0 ms.

Independently verify actual Cloudflare account Free entitlement and Free-enforced behavior; do not infer it from `default_usage_model=standard`. Keep #119 **NOT PASS**, #118 independently unsigned and PR #120 Draft until their separate evidence gates are met. Production remains untouched; direct `/mcp` measurement is not Portal acceptance.

References: [Cloudflare CPU profiling](https://developers.cloudflare.com/workers/observability/dev-tools/cpu-usage/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).
