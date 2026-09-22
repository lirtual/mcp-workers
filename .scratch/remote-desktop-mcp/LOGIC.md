# LOGIC — #173 isolated device/DO relay (THROWAWAY)

**Do not merge to main or deploy.** Scratch source only; no production auth, trusted remote tools, or public service. Only `sandbox_ping` and `sandbox_list_directory` are exposed. For a CI-only end-to-end proof, the latter can invoke **actual pinned Desktop Commander 0.2.51** through a network-disabled, read-only, non-root Docker container using `stdio`; no generic upstream tool surface is exposed. Real Windows/Linux host installation and user-level permissions remain unverified.

## Design question

Can a per-device Durable Object coordinate one outbound WebSocket and multiple bounded MCP calls while rejecting disconnected, revoked and stale sessions, with no local shell/file access?

## Contents

- `relay-state.mjs`: testable correlation state machine. Call IDs must be unique, pending calls are removed on timeout, disconnect or revocation, and responses from superseded sockets are dropped.
- `index.mjs`: non-production Worker + SQLite-backed Durable Object. `/mcp` supports `initialize`, `ping`, `tools/list`, and **two restricted tools**, `sandbox_ping` and `sandbox_list_directory` (no caller-supplied paths). A separate `/device` receives an outbound WebSocket. Admin can permanently `POST /admin/revoke`.
- `test/relay-state.test.mjs`: seven Node state-machine tests.
- `local-bridge.mjs`: outbound-only loopback/WSS sandbox bridge with a fixed canonical directory, no commands, no arbitrary paths or writes; directory listing is non-recursive and excludes symlinks.
- `test/workerd-integration.mjs`: local workerd and DO integration against both a synthetic device for concurrent/timeout cases and the restricted local bridge. Additionally tests the **full MCP → Worker → DO → outbound WebSocket → Docker-isolated real Desktop Commander 0.2.51 stdio → WebSocket → MCP** round trip against a temporary fixture. Caller-chosen paths rejected; three ephemeral credentials in `.dev.vars` removed afterwards.
- `isolated-upstream.mjs`: **throwaway CI-only** fixed-root adapter. Runs exactly one allowed upstream `list_directory` in a disposable non-root, no-network, read-only Docker container; exposes no arbitrary tool name or caller-provided directory, drops container capabilities, caps resources and output, returns sanitized failure codes.
- `test/upstream-stdio-proof.mjs`: direct local stdio initialization, discovery and fixed-directory read of actual `@wonderwhy-er/desktop-commander@0.2.51`, optionally provides bounded structured output to the fixed-root adapter.
- `test/eviction.test.mjs` and `vitest.config.mjs`: Cloudflare Vitest proof using `evictDurableObject(stub, { webSockets: "hibernate" })`. WebSocket survives forced eviction, the new DO instance restores its attachment, and a fresh MCP request gets a response. **Revocation followed by forced eviction now passes**, both with no socket and with an already-connected device. Earlier timeout ([Actions #35761624622](https://github.com/lirtual/mcp-workers/actions/runs/35761624622)) was addressed by consuming the `/revoke` response before eviction; Cloudflare’s helper waits for in-flight requests to drain. [Actions #35762412556](https://github.com/lirtual/mcp-workers/actions/runs/35762412556) verifies all three eviction tests on the exact code HEAD `cb0780c978219a1a8c8c614c47be488e212c9e3d`.
- `wrangler.jsonc`: isolated DO binding with `workers_dev=false` and `preview_urls=false`.
- CI: standalone GitHub Action runs seven state tests, Wrangler dry-run, local workerd/DO integration with **real upstream end-to-end read-only round trip**, direct isolated stdio check, forced-hibernation proof, and non-public configuration assertion; pinned `ws@8.18.3`, `vitest@4.1.0`, `@cloudflare/vitest-plugin@1.0.0`, `@wonderwhy-er/desktop-commander@0.2.51` only in temporary scratch CI. There is **no deploy step**.

## Isolation and credentials

The Worker fails closed if any of `PROTOTYPE_MCP_TOKEN`, `PROTOTYPE_DEVICE_TOKEN`, `PROTOTYPE_ADMIN_TOKEN` is unset or shorter than 24 characters. Never put real credentials in this public repository. The deliberately simplified static test tokens are **not an OAuth implementation**, nor are they compatible by themselves with ChatGPT. The paths have independent credentials and are not intentionally exposed to the public internet.

## Model and constraints

1. `connect(generation)` supersedes previous sockets and fails old pending calls. Each request has a random ID and is associated with the current connection generation.
2. `result` only accepts a matching ID from the current socket. Late, duplicate, stale and unknown IDs are ignored.
3. `disconnect`, `timeout` and `revoke` release pending promises. Revocation persists to Durable Object storage before cancellation; restoration checks storage.
4. On DO wakeup, use `ctx.getWebSockets()` and socket attachments to reconstruct the **connection**. The in-memory pending-call map is intentionally not durable. A forced-eviction round trip has passed in the Cloudflare test runtime. In-flight request loss, device restart, and hosted Cloudflare behavior remain unverified. Revoked-state recovery after eviction is verified in the isolated test runtime for both disconnected and previously connected devices.
5. Maximum 8192 bytes of inbound JSON; echoed input 64 characters; 1.5-second ping timeout, 25-second restricted directory-call timeout, 20-second isolated Docker process timeout. These are experimental limits, not a final product policy.

## HTTP ingress hardening checkpoint

- The 8192-byte prototype HTTP cap is enforced **while consuming** the request stream, with an early Content-Length rejection where available. It no longer reads an unbounded body into a string before checking its length; UTF-8 bytes are counted rather than characters.
- Local workerd negative cases verify malformed JSON, oversized ASCII and multibyte UTF-8 bodies, invalid MCP and independent admin/device credentials, forbidden `execute_command` and unexpected arguments. Existing bounded real-upstream round trip and DO eviction tests remain included.
- Verified code HEAD `f7f0fb48f3c591bccd57a979d43d44b1e6d5c446`: [prototype Actions #35764935896](https://github.com/lirtual/mcp-workers/actions/runs/35764935896) and [repository CI #35764935954](https://github.com/lirtual/mcp-workers/actions/runs/35764935954), both SUCCESS.
- This is ingress resource-limit evidence, **not** MCP Inspector / OAuth acceptance. WebSocket oversize and in-flight eviction still need their own targeted negative tests. Static prototype bearer tokens remain non-production.

## What this does NOT prove

- Hosted Cloudflare DO behavior or in-flight request behavior during eviction. The **local end-to-end proof now reaches the real upstream executable**, but only in an ephemeral isolated CI container.
- Proper OAuth discovery, PKCE, token refresh or Portal/ChatGPT interoperability.
- Secure Windows/Linux device packaging, OS sandbox operation on the user’s machine, or any remote shell/write capability. The fixed-root test-only local bridge can list one ephemeral directory but cannot read arbitrary caller-chosen files.
- That secret checks and simple synthetic JSON-RPC framing satisfy a production MCP security review.
- Availability, error handling and deployment on real Cloudflare bindings.

## Verification command

```bash
node --test .scratch/remote-desktop-mcp/test/relay-state.test.mjs
pnpm --filter workflow-mcp-worker exec wrangler deploy --dry-run \
  --config ../../.scratch/remote-desktop-mcp/wrangler.jsonc \
  --outdir /tmp/remote-desktop-prototype-173
```

Local sandbox-bridge acceptance passed at HEAD `92417f29cb18dbc75452e7fe9d1a4118a0c70668`: [prototype Actions #35760539329](https://github.com/lirtual/mcp-workers/actions/runs/35760539329) and [main CI #35760539391](https://github.com/lirtual/mcp-workers/actions/runs/35760539391) both succeeded. Latest [prototype Actions #35762412556](https://github.com/lirtual/mcp-workers/actions/runs/35762412556) and [main CI #35762412244](https://github.com/lirtual/mcp-workers/actions/runs/35762412244) both passed at exact HEAD `cb0780c978219a1a8c8c614c47be488e212c9e3d`: seven state-machine tests, local workerd integration, and three DO forced-eviction tests (hibernated socket recovery, revoked state recovery, and live-device revoke + recovery). [Full real-upstream relay Actions #35764043936](https://github.com/lirtual/mcp-workers/actions/runs/35764043936) and [repository CI #35764044071](https://github.com/lirtual/mcp-workers/actions/runs/35764044071) both passed at exact HEAD `1e2413cb03b53fb37423cfcbb083971363c5ac60`; the local workerd log explicitly reports the real isolated stdio round trip. Keep #173 open for genuine OAuth / ChatGPT, Windows/Linux real-device, independently hosted Cloudflare and remaining security acceptance. See [Cloudflare DO WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) and [current DO testing guidance](https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/).
