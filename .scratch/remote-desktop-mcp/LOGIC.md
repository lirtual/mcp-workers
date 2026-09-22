# LOGIC — #173 isolated device/DO relay (THROWAWAY)

**Do not merge to main or deploy.** Scratch source only; no production auth, trusted remote tools, or public service. The upstream Desktop Commander process is **not launched**: this phase uses only `sandbox_ping`. The pinned executor version / actual desktop host integration is not yet verified.

## Design question

Can a per-device Durable Object coordinate one outbound WebSocket and multiple bounded MCP calls while rejecting disconnected, revoked and stale sessions, with no local shell/file access?

## Contents

- `relay-state.mjs`: testable correlation state machine. Call IDs must be unique, pending calls are removed on timeout, disconnect or revocation, and responses from superseded sockets are dropped.
- `index.mjs`: non-production Worker + SQLite-backed Durable Object. `/mcp` supports `initialize`, `ping`, `tools/list`, and a **single harmless** `tools/call` named `sandbox_ping`. A separate `/device` receives an outbound WebSocket. Admin can permanently `POST /admin/revoke`.
- `test/relay-state.test.mjs`: Node tests of the state machine; not actual workerd or OAuth tests.
- `wrangler.jsonc`: isolated DO binding with `workers_dev=false` and `preview_urls=false`.
- CI: standalone GitHub Action runs state tests and Wrangler dry-run; there is **no deploy step**.

## Isolation and credentials

The Worker fails closed if any of `PROTOTYPE_MCP_TOKEN`, `PROTOTYPE_DEVICE_TOKEN`, `PROTOTYPE_ADMIN_TOKEN` is unset or shorter than 24 characters. Never put real credentials in this public repository. The deliberately simplified static test tokens are **not an OAuth implementation**, nor are they compatible by themselves with ChatGPT. The paths have independent credentials and are not intentionally exposed to the public internet.

## Model and constraints

1. `connect(generation)` supersedes previous sockets and fails old pending calls. Each request has a random ID and is associated with the current connection generation.
2. `result` only accepts a matching ID from the current socket. Late, duplicate, stale and unknown IDs are ignored.
3. `disconnect`, `timeout` and `revoke` release pending promises. Revocation persists to Durable Object storage before cancellation; restoration checks storage.
4. On DO wakeup, use `ctx.getWebSockets()` and socket attachments to reconstruct the **connection**. The in-memory pending-call map is intentionally not durable. An outstanding HTTP fetch should hold the object active; real hibernation/eviction, restart and late-result behavior still require workerd testing.
5. Maximum 8192 bytes of inbound JSON; echoed input 64 characters; 1.5-second call timeout. These are experimental limits, not a final product policy.

## What this does NOT prove

- Actual DO WebSocket handshake, hibernation/eviction, concurrency or a real outbound bridge (requires workerd integration).
- Proper OAuth discovery, PKCE, token refresh or Portal/ChatGPT interoperability.
- Running an upstream Desktop Commander binary, secure Windows/Linux device packaging, shell or file access.
- That secret checks and simple synthetic JSON-RPC framing satisfy a production MCP security review.
- Availability, error handling and deployment on real Cloudflare bindings.

## Verification command

```bash
node --test .scratch/remote-desktop-mcp/test/*.test.mjs
pnpm --filter workflow-mcp-worker exec wrangler deploy --dry-run \
  --config ../../.scratch/remote-desktop-mcp/wrangler.jsonc \
  --outdir /tmp/remote-desktop-prototype-173
```

An exact HEAD/Actions result must be recorded on #173 before any acceptance claim. Keep #173 open until workerd runtime, security, and MCP validation gates are evidenced. See [Cloudflare DO WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) and [current DO testing guidance](https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/).
