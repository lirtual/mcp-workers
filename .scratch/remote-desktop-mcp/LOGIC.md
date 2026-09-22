# LOGIC — #173 isolated device/DO relay (THROWAWAY)

**Do not merge to main or deploy.** Scratch source only; no production auth, trusted remote tools, or public service. The upstream Desktop Commander process is **not launched**: this phase exposes only `sandbox_ping` and `sandbox_list_directory`. The latter reads a test-only fixed root via a narrow local bridge; it is NOT the upstream Desktop Commander process. The pinned upstream executor version / actual desktop host integration is not yet verified.

## Design question

Can a per-device Durable Object coordinate one outbound WebSocket and multiple bounded MCP calls while rejecting disconnected, revoked and stale sessions, with no local shell/file access?

## Contents

- `relay-state.mjs`: testable correlation state machine. Call IDs must be unique, pending calls are removed on timeout, disconnect or revocation, and responses from superseded sockets are dropped.
- `index.mjs`: non-production Worker + SQLite-backed Durable Object. `/mcp` supports `initialize`, `ping`, `tools/list`, and **two restricted tools**, `sandbox_ping` and `sandbox_list_directory` (no caller-supplied paths). A separate `/device` receives an outbound WebSocket. Admin can permanently `POST /admin/revoke`.
- `test/relay-state.test.mjs`: seven Node state-machine tests.
- `local-bridge.mjs`: outbound-only loopback/WSS sandbox bridge with a fixed canonical directory, no commands, no arbitrary paths or writes; directory listing is non-recursive and excludes symlinks.
- `test/workerd-integration.mjs`: isolated local workerd test with a synthetic device for concurrent/timeout cases, followed by the real restricted bridge reading a temporary fixture. It checks auth, offline, invalid paths, connect/reconnect, and revocation. Three ephemeral credentials in `.dev.vars` are removed afterwards.
- `test/eviction.test.mjs` and `vitest.config.mjs`: Cloudflare Vitest proof using `evictDurableObject(stub, { webSockets: "hibernate" })`. WebSocket survives forced eviction, the new DO instance restores its attachment, and a fresh MCP request gets a response. **Revocation followed by forced eviction now passes**, both with no socket and with an already-connected device. Earlier timeout ([Actions #35761624622](https://github.com/lirtual/mcp-workers/actions/runs/35761624622)) was addressed by consuming the `/revoke` response before eviction; Cloudflare’s helper waits for in-flight requests to drain. [Actions #35762412556](https://github.com/lirtual/mcp-workers/actions/runs/35762412556) verifies all three eviction tests on the exact code HEAD `cb0780c978219a1a8c8c614c47be488e212c9e3d`.
- `wrangler.jsonc`: isolated DO binding with `workers_dev=false` and `preview_urls=false`.
- CI: standalone GitHub Action runs seven state tests, Wrangler dry-run, local workerd integration, forced-hibernation proof, and non-public configuration assertion; pinned `ws@8.18.3`, `vitest@4.1.0`, `@cloudflare/vitest-plugin@1.0.0` only in temporary scratch CI. There is **no deploy step**.

## Isolation and credentials

The Worker fails closed if any of `PROTOTYPE_MCP_TOKEN`, `PROTOTYPE_DEVICE_TOKEN`, `PROTOTYPE_ADMIN_TOKEN` is unset or shorter than 24 characters. Never put real credentials in this public repository. The deliberately simplified static test tokens are **not an OAuth implementation**, nor are they compatible by themselves with ChatGPT. The paths have independent credentials and are not intentionally exposed to the public internet.

## Model and constraints

1. `connect(generation)` supersedes previous sockets and fails old pending calls. Each request has a random ID and is associated with the current connection generation.
2. `result` only accepts a matching ID from the current socket. Late, duplicate, stale and unknown IDs are ignored.
3. `disconnect`, `timeout` and `revoke` release pending promises. Revocation persists to Durable Object storage before cancellation; restoration checks storage.
4. On DO wakeup, use `ctx.getWebSockets()` and socket attachments to reconstruct the **connection**. The in-memory pending-call map is intentionally not durable. A forced-eviction round trip has passed in the Cloudflare test runtime. In-flight request loss, device restart, and hosted Cloudflare behavior remain unverified. Revoked-state recovery after eviction is verified in the isolated test runtime for both disconnected and previously connected devices.
5. Maximum 8192 bytes of inbound JSON; echoed input 64 characters; 1.5-second call timeout. These are experimental limits, not a final product policy.

## What this does NOT prove

- Hosted Cloudflare DO behavior, in-flight request behavior during eviction, or an outbound bridge to the real Desktop Commander executable. The isolated Vitest test does force eviction and prove attachment restore for an active socket.
- Proper OAuth discovery, PKCE, token refresh or Portal/ChatGPT interoperability.
- Running an upstream Desktop Commander binary, secure Windows/Linux device packaging or shell access. The fixed-root test-only local bridge can list one ephemeral directory but cannot read arbitrary files.
- That secret checks and simple synthetic JSON-RPC framing satisfy a production MCP security review.
- Availability, error handling and deployment on real Cloudflare bindings.

## Verification command

```bash
node --test .scratch/remote-desktop-mcp/test/relay-state.test.mjs
pnpm --filter workflow-mcp-worker exec wrangler deploy --dry-run \
  --config ../../.scratch/remote-desktop-mcp/wrangler.jsonc \
  --outdir /tmp/remote-desktop-prototype-173
```

Local sandbox-bridge acceptance passed at HEAD `92417f29cb18dbc75452e7fe9d1a4118a0c70668`: [prototype Actions #35760539329](https://github.com/lirtual/mcp-workers/actions/runs/35760539329) and [main CI #35760539391](https://github.com/lirtual/mcp-workers/actions/runs/35760539391) both succeeded. Latest [prototype Actions #35762412556](https://github.com/lirtual/mcp-workers/actions/runs/35762412556) and [main CI #35762412244](https://github.com/lirtual/mcp-workers/actions/runs/35762412244) both passed at exact HEAD `cb0780c978219a1a8c8c614c47be488e212c9e3d`: seven state-machine tests, local workerd integration, and three DO forced-eviction tests (hibernated socket recovery, revoked state recovery, and live-device revoke + recovery). Keep #173 open until OAuth, real upstream-device isolation and actual ChatGPT integration gates are evidenced. See [Cloudflare DO WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) and [current DO testing guidance](https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/).
