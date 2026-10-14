# Remote Control MCP v2 — Minimal multi-device technical specification

Status: **draft, ready for design review; NOT an implementation or deployment authorization**.
Last updated: 2026-10-15. Owner-approved choices Q1–Q20 are captured in [ADRs 0014–0019](./adr/); particularly [ADR-0018](./adr/0018-v2-websocket-do-transport-and-portal-pairing.md) and [ADR-0019](./adr/0019-pairing-code-device-keys-and-72-hour-gate.md).
Current production v1 (single VPC Service + Cloudflare Tunnel + Linux Agent) is **untouched**. This spec describes a separately tested, opt-in v2.

## 1. Problem and proposed solution

The owner wants to install an Agent on Linux or WSL2 hosts in unrelated home, office and cloud networks, explicitly pair each installation once, then use **one existing authenticated MCP endpoint** to list and remotely control a chosen device. No public device address, inbound port, per-device Tunnel, manual Cloudflare secret copying or Cloudflare One/Mesh registration is required in v2.

Reuse existing Linux execution operations, argument validation, Agent-local operation receipts and managed sessions. Add minimal device-owned key identity, a short-term pairing protocol and an **Agent-initiated WSS ↔ one SQLite-backed Hibernating Durable Object** control connection. Keep Portal's `MCP_ACCESS_TOKEN` isolated to the MCP front door. Never turn a short pairing code or anonymous registration into Shell authorization.

## 2. User stories

1. As an owner, I want to install an Agent on Linux with a straightforward command, so that a home or cloud device can be added without Cloudflare dashboard setup.
2. As an owner, I want to install an Agent in WSL2, so that it can control my Linux environment without installing Cloudflare One Client.
3. As an owner, I want to see a ten-character pairing code on the device itself, so that I can identify a specific fresh installation.
4. As an owner, I want to inspect a pending device using my Portal-authenticated MCP, so that I can review its label and public-key fingerprint before approving it.
5. As an owner, I want to explicitly confirm one inspected pairing, so that a one-time code alone does not grant remote execution.
6. As an owner, I want to list only paired devices and their observed availability, so that I can select the correct target.
7. As an owner, I want remote commands to require the target `device_id`, so that parallel chats cannot redirect commands by modifying a global default.
8. As an owner, I want offline devices to reject new commands rather than queue them, so that old Shell instructions cannot run unexpectedly.
9. As an owner, I want already-running commands to continue after an ordinary disconnection and have their status queried after reconnection, so that I can safely reconcile uncertain results without a replay.
10. As an owner, I want one device's credentials revoked and its connection rejected without affecting others, so that lost or retired devices cannot accept new operations.
11. As an owner, I want online Agent-owned processes to receive a best-effort stop request on explicit device revocation, so that I get an accurate report of what could and could not be stopped.
12. As an owner, I want a reinstalled device to require fresh pairing, so that old credentials cannot be silently inherited.
13. As an owner, I want automatic Agent reconnect after service/network restarts, so that control recovers without manual reconfiguration.
14. As an owner, I want bounded device, pairing and error outputs, so that logs and MCP responses do not leak private key material, command payloads or credentials.
15. As a maintainer, I want an observed 72-hour five-Agent Hibernation and Free-quota soak, so that v2 does not silently exhaust the shared Cloudflare Free plan.
16. As a maintainer, I want v1 production unchanged throughout v2 testing, so that an incomplete design cannot interrupt the existing connection.

## 3. Component boundaries and existing seams

| Component | Owns | Explicitly does not own |
| --- | --- | --- |
| `apps/remote-control-mcp-worker` | One `/mcp` authenticated ingress, curated tools, argument/body bounds, owner review/confirmation and device-targeted RPC to DO | Device runtime, Shell, arbitrary private-IP proxy, anonymous approval |
| SQLite-backed owner DO | Pending pairings, stable `device_id`, public keys, deny/revoke state, authenticated hibernating WS connections, bounded request/response dispatch | Arbitrary command execution, long-term process logs, durable job queue |
| `apps/remote-control-agent` (v2 entry/transport) | Local key generation and secret storage, local pairing code display, outbound WSS/reconnect, existing Node file/Shell/process implementation and receipts | MCP Server or Portal credential, Cloudflare control-plane administration |
| `packages/portal-auth` (existing) | Same independent static Bearer verification for the **MCP ingress** | Agent credential, human identity attestation |

Use a single coordinator DO for the personal owner, selected internally from trusted server configuration; **never** use a caller/Agent-supplied owner ID to create unlimited objects. Preserve current tool implementations and reuse the highest-level MCP→Worker→Agent execution seam in tests. No new CI workflow or platform service required by this spec.

## 4. Minimal public/API contracts

### 4.1 MCP surface — authenticated with existing `MCP_ACCESS_TOKEN`

- `list_devices()` → bounded list of `{device_id, name, status, last_seen_at?}`, no private network address, public key, pairing code or sensitive metadata.
- `pairing_lookup({code})` → `{pairing_id, sanitized_name, public_key_fingerprint, expires_at, status:"pending"}`. **Read-only**. May not grant a key. This call must be available only through the existing Portal-authenticated MCP entrypoint.
- `pairing_confirm({pairing_id, expected_fingerprint, approve})` → `{status:"approved"|"denied"|"expired", device_id?}`. **Distinct** from lookup; compare fingerprint to immutable pending key; a request cannot approve an uninspected/stale lookup. The actual ChatGPT/Portal UI's human-review guarantee is a **blocking client validation**, not an implied property of a Bearer.
- `revoke_device({device_id})` → `{status:"revoked"|"revocation_pending", stop_result:"confirmed"|"best_effort"|"unavailable"}` with truthful remote-process status. For WS+DO, deny device identity and close socket; no Cloudflare One enrollment exists to delete.
- All v2 remote operations add explicit **`device_id`** to existing arguments and retain stable `operation_id` on mutations. A `get_operation_status` query also targets a specific `device_id`. Do not expose caller-provided URLs, IPs, ports or a writable global selected device.

For v1 coexistence, use an explicit v1 path or unambiguous compatibility layer; **never silently route a call without `device_id` to an arbitrary v2 device**. Exact client-visible names and compatibility compatibility checks should be tested against existing `LOCAL_TOOLS` before implementation.

### 4.2 Narrow Agent network surface — no Portal Bearer

- `POST /agent/pair/start` (or equivalent authenticated-by-proof bootstrap): accepts bounded public key, key-possession proof, locally generated code verifier/challenge metadata; stores one pending pairing with a 10-minute deadline. Creates **no execution capability**. A public endpoint must not enumerate owners or resolve a user-supplied DO scope.
- `GET /agent/connect` WSS upgrade: unauthenticated connection receives **no commands**. Require a fresh server challenge signed by the device's private key and bounded authentication deadline; verify against the approved `device_id` public key and a durable non-revoked record before promoting this socket to an operational Agent. Only the server sends commands; unpaired/revoked/unknown keys rejected.
- Per-message envelope is versioned and bounded: `{type, request_id, device_id, operation_id?, tool?, arguments?, result?}`. Route only to a server-authorized destination; signatures/fresh challenges bind session scope to prevent cross-device replay. A correlation `request_id` is not a substitute for `operation_id` idempotency.
- Response after ambiguous disconnection: `{device_id, operation_id, status:"timeout_unknown"}` for submitted mutations; **never** silently resend the mutating request. Query existing local receipt when the specific Agent is reachable again.
- WSS bootstrap/auth expiry, frame size and concurrency caps remain server-side constants, not individually configurable environment variables.

**Security note:** an Agent-initiated code is not automatically safe. The pending registration must be bound to **the same local key**, code and owner-visible fingerprint; guesses, stolen codes, wrong-key claims, duplicate pending IDs and concurrent confirmations are denied. A single bearer/code entry cannot execute Shell. Pairing code, Portal bearer and device private key are three distinct materials.

## 5. Pairing/credential lifecycle — accepted fixed requirements

States: `unpaired → pending (10 min) → owner_reviewed → approved → connected/offline → revoked`; `expired` and `denied` terminate pending pairing. Reinstall creates a **different** identity and passes through pairing again.

- Generate exactly **10 uniformly random Base32 symbols** from secure randomness (50 entropy bits), case-folded on input; separators are not counted in 10 symbols. Only one successful redemption/approval. Pending state has an expiry, bounded request/attempt budget and replay-resistant atomic transition.
- For each fresh installation generate an independent device private/public keypair **locally**, protect private key with OS-user file permissions, never upload it. Choose a standard signature algorithm implemented by both Node and Cloudflare WebCrypto (candidate: Ed25519, subject to cross-runtime verification) and version wire encodings for later key rotation; no bespoke cryptography.
- Sign a **fresh, short-lived server challenge** with context binding (protocol version, domain, owner-scoped installation identity, `device_id`, unique challenge). Reject stale/duplicate proofs. Upgrade and every command dispatch must check current non-revoked durable device state; a socket attachment or old handshake does not supersede a revocation.
- A fingerprint identifies the exact pending public key to the owner, not the OS hostname or merely a ten-character code. The approval protocol must retain **proof that the pending request was previously looked up**. The actual Portal client must display details and obtain an explicit second owner confirmation; an LLM-only pair of tool calls is **not** a proven human-presence signal. Escalate to a separate user-verifiable confirmation channel if the real client does not satisfy this acceptance gate.
- On revoke: commit a deny/tombstone first, reject new upgrades/messages/commands, best-effort stop online Agent-owned sessions, close existing socket. Offline execution already started cannot be forcibly terminated and must not be reported as stopped. No device enrollment cleanup is needed in Cloudflare One for this WS+DO-only design.

## 6. Durable state, online status and Hibernation

**Minimal DO SQLite records (conceptual, no separate database):**
- `pending_pairing`: request ID, normalized code verifier (never raw code), public key and fingerprint, pending-state timestamps, attempt counters, approval view reference.
- `device`: opaque `device_id`, unique public key, friendly label, approved/revoked status, creation/revocation timestamps; a tombstone must survive reconnect and hibernation.
- No cloud-side `operation_receipt` table: the existing Agent store owns actual mutation outcomes. Only short-lived in-flight RPC correlation can reside in DO memory during a **bounded** active call.

Use `ctx.acceptWebSocket()`, `webSocketMessage()`/`webSocketClose()`, `serializeAttachment()`/`deserializeAttachment()`, `getWebSockets()` to rebuild ephemeral connection handles following hibernation. Socket attachment contains only minimum nonsecret `device_id`/connection epoch; authorization is looked up from durable SQLite on every dispatch and upgrade.

**Hibernation vs liveness:** Do **not** send frequent application-layer heartbeats for each device: five staggered 30-second heartbeats can prevent a shared DO ever reaching the inactivity window for hibernation. Prefer Cloudflare `setWebSocketAutoResponse()` (which does not run handler JS) and, where appropriate, `getWebSocketAutoResponseTimestamp()` for observed liveness when `list_devices` is called. Close events and bounded command timeouts also indicate unavailability. Actual detection latency for silent network failure must be measured and documented; "immediately unavailable" means immediately **once failure is known**, not instantaneous knowledge of every partition.

Bound each RPC's connected wait, then return `timeout_unknown` or known receipt state, rather than holding a DO event/Promise alive for a multi-minute Shell command. Never keep per-socket activity timers, unbounded `waitUntil` or open outbound WebSockets that prevent hibernation. Treat DO isolate hibernation/restart as routine and restore only durable/authenticated state.

## 7. Acceptance and rollout (no new CI)

Run at the highest external seams: authenticated MCP request → Worker/DO → disposable native Agent; separate malicious bootstrap/WS tests. Use existing tests and local scripts; **do not add GitHub Actions workflows**.

1. **Portal approval:** wrong/missing Bearer, lookup-only, changed fingerprint, expired code, duplicate/replayed confirmation and fake "owner-confirmed" arguments must never grant access. Test actual ChatGPT client two-step confirmation; automatic model tool calls without verifiable user consent remain a release **blocker**.
2. **Device identity:** stolen old key, mismatched signature, replayed challenge, forged device ID, duplicate WS, and revoked/reinstalled identity must fail closed; other paired devices remain available.
3. **Offline/mutation:** Linux + WSL2 in at least two distinct networks, service and host restart, silent partition, stale socket replacement, uncertain mutation receipt and command non-replay; existing Agent process ownership retained.
4. **Revoke:** new commands refused immediately; online owned-process best-effort stop outcome reported; offline/compromised Agent processes never falsely certified stopped.
5. **Cloudflare Free soak: 5 simulated clients × 72 continuous hours (not yet run).** Include idle and bounded active tests, disconnection, re-auth, DO wake after idle, Worker/DO restart and current IMA DO shared-account load. Record hourly: WS connection count, hibernation/wake evidence, DO billed requests, GB-s, SQLite rows read/written/storage, Workers requests, failed/429/5xx counts and peak backpressure. Use observed account quota headroom rather than simulated numbers to decide whether Free tier is sustainable.
6. **Published quotas (as of 2026-10-15):** SQLite-backed DO Free allows **100,000 DO requests/day, 13,000 GB-s/day, 5 million SQLite rows read/day, 100,000 rows written/day and 5 GB stored** account-wide. Incoming WS application messages count 20:1 for DO request billing; frontend Worker quotas are separate. One DO kept non-hibernating for 24 hours is roughly **10,800 GB-s**. Free excess operations fail; paid tier migration is neither assumed nor authorized.
7. **Release control:** v1 remains unchanged and continuously usable throughout development and nonproduction proof. Any v2 Worker binding/Secret, hosted test Cloudflare resource, real device install and production cutover require an independently authorized step and rollback plan. Successful documentation/CI tests alone do not authorize a production deployment.

## 8. Non-goals

- Native Windows/macOS Shell execution, graphical desktop, mouse/keyboard/PTY.
- Automatic Agent registration without explicit owner review; OAuth/Cloudflare Access or reusable Cloudflare One Client/Mesh enrollment.
- Shared `REMOTE_CONTROL_DEVICE_TOKEN`, Portal Bearer in Agent, Cloudflare admin token in installer.
- Device-wide file/shell sandbox claim: Agent executes under existing OS account's privileges, same as current v1.
- Offline job queue, cron/workflow engine, DO-side command receipts, D1/KV/R2, autoscaling/fleet tenant controls, dashboard or auto-wake of sleeping WSL2/PC.
- New CI workflows or modification of production credentials and live Worker/Tunnel/Agent.

## 9. Decision closure and remaining risks

**Confirmed:** Q1–Q20 decisions, ADR-0019 code/key/proof and 72h soak requirements, WS+DO v2 design and independent v1 production.

**Still needs a proof or a small follow-up decision (NOT secretly assumed approved):**
- Can an actual MCP Portal/ChatGPT UI make two separate tool calls correspond to verifiable **human review and deliberate confirmation**? If not, use a separate confirmation channel; do not substitute an LLM-generated `approve: true`.
- Finalized signature algorithm / trust bootstrap and replay boundaries; exact pairing attempt/throttle policy, use of keyed verifier salt, and duplicate socket fencing.
- Narrow implementation constants for silent-partition offline threshold, per-call active wait, resource limits, retention/cleanup and key rotation.
- Nonproduction environment and 72h soak evidence, account-wide DO headroom, WSL2 auto-start feasibility and production rollback plan.

## References

- [Domain context](./CONTEXT.md)
- [ADR-0019](./adr/0019-pairing-code-device-keys-and-72-hour-gate.md)
- [Pairing security and Hibernation acceptance](./V2-PAIRING-AND-HIBERNATION-ACCEPTANCE.md)
- [Existing native v1 Spec](./SPEC.md)
- https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- https://developers.cloudflare.com/durable-objects/api/state/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
