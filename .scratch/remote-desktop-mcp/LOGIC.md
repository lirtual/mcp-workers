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

The Worker fails closed unless all three `PROTOTYPE_MCP_TOKEN`, `PROTOTYPE_DEVICE_TOKEN`, `PROTOTYPE_ADMIN_TOKEN` are present and at least 24 characters each, and `PROTOTYPE_ALLOWED_ORIGIN` is set to one exact HTTP(S) origin. Never put real credentials in this public repository. The deliberately simplified static test tokens are **not an OAuth implementation**, nor are they compatible by themselves with ChatGPT. The paths have independent credentials and are not intentionally exposed to the public internet.

## Model and constraints

1. `connect(generation)` supersedes previous sockets and fails old pending calls. Each request has a random ID and is associated with the current connection generation.
2. `result` only accepts a matching ID from the current socket. Late, duplicate, stale and unknown IDs are ignored.
3. `disconnect`, `timeout` and `revoke` release pending promises. Revocation persists to Durable Object storage before cancellation; restoration checks storage.
4. On DO wakeup, use `ctx.getWebSockets()` and socket attachments to reconstruct the **connection**. The in-memory pending-call map is intentionally not durable. A forced-eviction round trip has passed in the Cloudflare test runtime. A CI-only graceful-eviction test now verifies that a pending HTTP call finishes and its response body is consumed before the instance is evicted, then a new call recovers on the same hibernated WebSocket. **Forced process termination, actual hosted Cloudflare shutdown/in-flight behavior, and device restart remain unverified.** Revoked-state recovery after eviction is verified in the isolated test runtime for both disconnected and previously connected devices.
5. Maximum 8192 bytes of inbound JSON; echoed input 64 characters; 1.5-second ping timeout, 25-second restricted directory-call timeout, 20-second isolated Docker process timeout. These are experimental limits, not a final product policy.

## HTTP ingress hardening checkpoint

- The 8192-byte prototype HTTP cap is enforced **while consuming** the request stream, with an early Content-Length rejection where available. It no longer reads an unbounded body into a string before checking its length; UTF-8 bytes are counted rather than characters.
- Local workerd negative cases verify malformed JSON, oversized ASCII and multibyte UTF-8 bodies, invalid MCP and independent admin/device credentials, forbidden `execute_command` and unexpected arguments. Existing bounded real-upstream round trip and DO eviction tests remain included.
- Verified code HEAD `f7f0fb48f3c591bccd57a979d43d44b1e6d5c446`: [prototype Actions #35764935896](https://github.com/lirtual/mcp-workers/actions/runs/35764935896) and [repository CI #35764935954](https://github.com/lirtual/mcp-workers/actions/runs/35764935954), both SUCCESS.
- Local workerd now also checks **oversized multibyte UTF-8 WebSocket frames are closed with code 1009** and malformed device JSON frames with code 1007; a subsequent device connection can recover and still complete the real upstream read-only call. Tested code HEAD `97d999fa79ebb5c497b96e43f2a83d3cf2ef602e`: [prototype Actions #35765276440](https://github.com/lirtual/mcp-workers/actions/runs/35765276440) and [repository CI #35765276584](https://github.com/lirtual/mcp-workers/actions/runs/35765276584), both SUCCESS.
- These are resource-limit and malformed-frame proofs, **not** MCP Inspector / OAuth acceptance. Graceful in-flight eviction is now covered by a dedicated local test; forced abort, real hosted shutdown and device restart remain separate. Static prototype bearer tokens remain non-production.

## Official MCP Inspector and version boundary (2026-09-23)

- Official `@modelcontextprotocol/inspector@2.7.0` CLI (not hand-written JSON-RPC) verified the legacy Streamable HTTP connection, `tools/list` and `sandbox_ping` `tools/call` against local workerd.
- The prototype deliberately negotiates `2025-06-18`; post-initialize `MCP-Protocol-Version` headers with `2026-07-28` or `2025-11-25` are **rejected** with HTTP 400, while `2025-06-18` is accepted. This documents an intentional compatibility limit, **not** newer-protocol support.
- Local workerd tests reject forged/cross-site `Origin` headers and permit same-origin. This only proves a local DNS-rebinding guard; production ChatGPT/Portal origins and OAuth discovery need separate security review.
- Evidence at exact HEAD `7c6304bec5020c9da2a01221f945802e352fad86`: [prototype Actions #35766442351](https://github.com/lirtual/mcp-workers/actions/runs/35766442351) and [repository CI #35766442426](https://github.com/lirtual/mcp-workers/actions/runs/35766442426), both SUCCESS. No public deployment or real ChatGPT validation.

## Official MCP Inspector and protocol security checkpoint

- The official `@modelcontextprotocol/inspector@2.7.0` CLI (`--transport http --protocol-era legacy`) performed `tools/list --strict` and `tools/call sandbox_ping` over the live local workerd `/mcp` route, with an ephemeral Authorization header. Both passed at HEAD `eb4853ee9a908b37fb967ef841b279843d7dda66`: [prototype Actions #35766077254](https://github.com/lirtual/mcp-workers/actions/runs/35766077254) and [repo CI #35766077314](https://github.com/lirtual/mcp-workers/actions/runs/35766077314), both SUCCESS.
- The prototype explicitly negotiates the **legacy `2025-06-18`** version. After initialization, unsupported `MCP-Protocol-Version` headers (`2025-11-25`, `2026-07-28`) get HTTP 400 rather than accidental acceptance. The 2026-07-28 era is a different protocol with no `initialize` handshake, different metadata and header requirements; it is **not implemented** in this throwaway prototype.
- Each incoming public Worker request requires `PROTOTYPE_ALLOWED_ORIGIN` to be configured as one exact HTTP(S) origin. The request host and any supplied `Origin` must match this explicit value; forged Host + matching attacker Origin is denied even though simple request-local Origin/Host comparisons would have passed. No dynamic public origins are enabled. These are **prototype-local** checks; production Cloudflare hostname / Portal / ChatGPT origin decisions await OAuth and deployment review.
- The bounded HTTP `Content-Length` early check uses a decimal-only pattern and is backed by the independent streaming byte count, so chunked or misleading lengths cannot bypass the 8192-byte cap.
- Latest tested code HEAD `67f5cc9852232de4be3bef74cc5f475ce8ac2c89`: [prototype Actions #35766814615](https://github.com/lirtual/mcp-workers/actions/runs/35766814615) and [repo CI #35766814678](https://github.com/lirtual/mcp-workers/actions/runs/35766814678), both SUCCESS. All previous device, real-upstream round-trip and forced DO eviction tests remain green.

## Active-call graceful eviction checkpoint

- The `cloudflare:test` `evictDurableObject(stub, { webSockets: "hibernate" })` helper **waits up to 30 seconds for in-flight requests to drain**; this tests graceful draining, not a forced crash. See [Cloudflare eviction testing guidance](https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/).
- New fourth Vitest case starts an actual DO `/invoke`, observes the outbound WebSocket dispatch, requests eviction while its reply is pending, sends the device result, fully consumes the HTTP response, awaits eviction, and verifies a fresh call still works on the restored socket.
- Implementation HEAD `75c27fbcc2e295fa301d5f8d21a0ea1aaef454e9`: [prototype Actions #35767652970](https://github.com/lirtual/mcp-workers/actions/runs/35767652970) and [repo CI #35767653048](https://github.com/lirtual/mcp-workers/actions/runs/35767653048) both **SUCCESS**. Earlier three hibernation/revocation cases and the isolated Desktop Commander 0.2.51 round trip remain in the green suite.
- **Do not infer recovery from a hard process kill or a deployed Cloudflare DO** from this test. Both still need independent checks.

## What this does NOT prove

- Hosted Cloudflare DO shutdown behavior, hard-aborted in-flight requests, or device restart. **Graceful in-flight draining is now locally verified**, and the real-upstream end-to-end proof still runs only in an isolated CI container.
- Proper OAuth discovery, PKCE, token refresh, current 2026-07-28 MCP protocol or Portal/ChatGPT interoperability. **Legacy MCP Inspector CLI tool list/call is now verified**, not full modern conformance.
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
