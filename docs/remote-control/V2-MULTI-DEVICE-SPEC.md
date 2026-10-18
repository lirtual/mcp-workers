# Remote Control MCP v2 — One authoritative multi-device Spec

**Status:** design accepted and being implemented in [Draft PR #58](https://github.com/lirtual/mcp-workers/pull/58); production deployment remains blocked on independent human-confirmation and the single-device/48h soak gate. Updated 2026-10-17.
Authority: [ADR-0014 — transport](./adr/0014-v2-multi-device-ws-do.md), [ADR-0015 — pairing](./adr/0015-v2-pairing-and-identity.md). Existing [v1 Spec](./SPEC.md) continues to govern the deployed single-device path.

## Goal

One Remote Control MCP controls separately paired Linux/WSL2 Agents across unrelated networks, with near-one-command installation, explicit per-operation device selection and independent revocation. Reuse the existing native Node.js file/Shell/managed-process implementation and **Agent-local operation receipts**. The v2 Agent opens outbound WSS to one **SQLite-backed Durable Object using WebSocket Hibernation**. No device public IP, port forwarding, Tunnel, Cloudflare One Client or Mesh enrolment for v2.

## User stories

1. As an owner, I want one straightforward install on Linux/WSL2, so that devices on other networks can join without Cloudflare account setup.
2. As an owner, I want a short locally displayed pairing code, so that I can identify an installation before approving it.
3. As an owner, I want **only one 10-character pairing code and one 12-character confirmation challenge** in the default UX, with optional local fingerprint inspection and **mandatory confirmation from the NEW device's terminal**, so model-only MCP calls cannot approve it.
4. As an owner, I want `list_devices` with stable IDs and observed status, so that I can target the correct host.
5. As an owner, I want every v2 file/Shell/process command to name its target device, so that concurrent clients cannot redirect actions by changing a default.
6. As an owner, I want disconnected hosts to reject commands, reconnect automatically and reconcile local receipts, so that stale or uncertain mutations are not replayed.
7. As an owner, I want to remove a lost device without harming others, so that its identity and access remain revoked.
8. As an owner, I want online removal to attempt stopping only Agent-owned managed processes, so that the result is accurate without claiming to control an offline host.
9. As an owner, I want reinstallation to require new pairing, so that copied labels/old keys do not inherit authority.
10. As a maintainer, I want 48-hour single-Agent Hibernation and quota evidence and an independent v1 deployment, so that Free costs and rollback are verified before any cutover.

## Minimal changes to existing modules

| Module | v2 work | Reuse |
| --- | --- | --- |
| `apps/remote-control-mcp-worker` | Keep one authenticated `/mcp`, add `list_devices`, `pairing_lookup`, `pairing_prepare`, `revoke_device`, and explicit `device_id` on v2 tool calls; route to DO | Existing Portal auth, curated `LOCAL_TOOLS` schema/validation, error/redaction, operation IDs |
| New v2 owner DO module | Minimal SQLite `pending_pairing` and `device` records; bounded WS dispatch/correlation; revoke tombstones | Cloudflare DO Hibernation and SQLite; **one DO**, not a fleet platform |
| `apps/remote-control-agent` v2 transport entry | Device-local Ed25519 key, 10-symbol pairing code, outbound WSS, automatic reconnect, local service startup | Existing Linux tool handlers and loopback server can act as v2 execution adapter initially; no duplicated file/Shell engine or new cloud-side receipt storage |
| Existing v1 | **No change in production**; isolated preview/testing until approved cutover | Fixed VPC Service, Tunnel, current credential and worker semantics |

The existing Agent build invokes **`cc`** for its C session-supervisor helper; one-command onboarding must account for supported Node runtime, compiler or version-pinned prebuilt helper, Linux permissions and WSL2 startup. Installing an Agent without handling those prerequisites does **not** satisfy the UX goal. Do not add a new CI workflow merely to package it.

## Stable identities and MCP contracts

- `device_id`: opaque server-issued per-installation identifier; public to authenticated MCP, never based on hostname/IP or user-provided URL. Friendly `name` is untrusted presentation only. Reinstallation creates a new ID/key.
- `operation_id`: existing Agent-local stable mutation identity and receipt; never substitute a WSS correlation identifier. Unknown outcome is `timeout_unknown`, not “failed / safe to retry”.
- `list_devices()` returns bounded `[{device_id,name,status,last_seen_at?}]`; availability means observed Agent connectivity, not merely network/host state.
- `pairing_lookup({code})`: Portal-authenticated **read-only** pending device lookup returning `pairing_id`, `name`, `fingerprint`, `expires_at`. Never approves a device.
- `pairing_prepare({pairing_id,expected_fingerprint})`: a separate authenticated MCP preparation action. Checks the MCP-observed fingerprint against the same immutable pending record and returns a **12-character random Base32 challenge (60 bits), one-use, maximum five minutes**. It does **not** approve a device or issue credentials. Owner copies the challenge to the **new device terminal**. A signed local response alone activates identity; a model-generated `approve:true` is rejected.
- `revoke_device({device_id})`: durably deny before any other effect, reject fresh connections/dispatch and close live socket. Attempt an authenticated internal best-effort stop of owned managed sessions if online, reporting `stop_confirmed`, `stop_unconfirmed` or `offline` honestly. No Cloudflare One registration exists to delete.
- Every v2 existing curated tool adds a validated `device_id` while retaining original tool names/arguments and mutation IDs. No global mutable default. The single-device v1 compatibility route cannot silently pick a v2 target.

## Agent-only pairing and authentication (separate from MCP)

1. Installer generates a new **Ed25519** pair locally and a cryptographically uniform **10-character Base32 code (50 random bits)**; displays only the pairing code in the default **10-minute** pending flow. The private key remains device-local with restricted OS permissions. The locally derived public-key fingerprint is available with an explicit `--show-fingerprint` install flag for additional visual verification.
2. A **bounded public, tool-less Agent bootstrap endpoint** registers a pending code verifier + exact public key/fingerprint in the fixed owner DO. It receives no Shell/file authority. Rate-limit submissions and code guesses, cap outstanding pending requests, expire and clean on access; no general queue or always-on alarm.
3. Owner supplies the code via Portal-authenticated `pairing_lookup`. MCP receives `pairing_id`, label and immutable fingerprint; `pairing_prepare` requires the same fingerprint and returns a short-lived one-use challenge bound to that public key. **No mandatory manual fingerprint comparison in the default UX**; optional owner verification uses `--show-fingerprint`. MCP lookup/prepare alone cannot activate a device, and no `pairing_confirm` tool is exposed.
4. The owner manually enters **only the 12-character MCP challenge** on the new device's local terminal/SSH; the original pairing code is retained in installer memory and never needs to be retyped. Its private key signs a domain-separated transcript binding pending code verifier, challenge and the immutable public key. The public, tool-less `/agent/pair/complete` endpoint verifies one-use challenge and signature, atomically consumes pending approval and issues a device ID. **This pairing proof is not a WSS login.** Later a fresh independent server nonce signs the authenticated operational `wss` session in #50. Never put long-lived keys, code or Portal Bearer into query strings/logs.
5. Every subsequent WSS reconnect uses a new challenge and the same approved local private key. Verify current SQLite authorization at connection and before **each command dispatch**, including after Hibernation wake. Use a deterministic per-device connection epoch to fence duplicate old sockets. Revoke permanently blocks the old key until a *new owner-approved pairing*.

**Security gate (refined 2026-10-16):** static Portal Bearer authenticates caller possession, not an actual human. **MCP-side fingerprint matching is cryptographic key binding, not an independent check of the physical device the owner intended; hiding the local fingerprint by default trades away manual mispairing detection.** The owner approved an independent **new-device terminal confirmation** to prevent autonomous MCP-only approval without adding OAuth or a dashboard. This is independent **only if ChatGPT and its other authorized tools cannot operate that terminal or access the new private key**. A compromised target/SSH session is not proof of a separate human; do not claim universal human-presence verification. Validate actual client/host boundaries before production.

## Device control and failure model

- Only authenticated MCP can request curated operations; only an approved, currently authorized Agent socket receives them. Agent independently validates operations and its OS permissions. Public bootstrap never executes tools.
- One short-lived WSS message envelope: `{version,type,request_id,device_id,operation_id?,tool?,arguments?,result?}`. Validate size/tool/schema and bind device identity on both ends; responses must match the initiating request ID and connection epoch. No arbitrary target host/URL, generic proxy, or cloud file/command-output archive.
- Short/read calls and acknowledgement of long-running `start_process` use **bounded RPC deadlines**. Extended processes run only under the Agent's existing managed-session contract. Do not await a multi-minute Shell command inside a DO request/promise: it prevents Hibernation.
- A known disconnection immediately marks offline; a silent partition has a bounded detection delay (must be measured, not claimed instantaneous). Auto reconnects with backoff, no queued commands and **no resubmission of uncertain mutations**. Status can be reconciled with the same `device_id + operation_id` after reconnection.
- An ordinary network loss **does not stop** an Agent-owned running process. Explicit removal denies new work first, attempts stopping *owned* sessions via a narrow internal control when possible and then closes the connection; an offline/compromised device's process may continue.
- WSL2 may be stopped while its Windows host is online; only actual Linux Agent reachability counts as “online.” Automatic start across Windows host reboot/WSL2 shutdown must be tested and must not be asserted by design alone.

## Hibernation, persistent state and Free quota

- The **SQLite-backed owner DO** stores minimal `pending_pairing` (code verifier, public key, expiry, status, attempts) and `device` (opaque ID, key, label, approval, revoked tombstone) records. No separate D1/KV/R2 or cloud-side operation-receipts.
- Use `ctx.acceptWebSocket()`, connection `serializeAttachment()`/`deserializeAttachment()` and `getWebSockets()`; attachments hold **nonsecret** `device_id`/epoch, but **SQLite** remains authoritative after DO eviction or code deployment.
- DO Hibernation requires *no scheduled `setInterval`/`setTimeout`*, no unbounded `waitUntil` or held-open outgoing I/O. Prefer protocol ping/pong or Cloudflare automatic WS responses; **frequent application-layer heartbeats on multiple devices can keep the one DO awake**. Read auto-response timestamps when requested and use measured offline detection, not a busy poller.
- Verified official Workers Free SQLite-DO limits: **100,000 DO request-billing units/day**, **13,000 GB-s/day**, **5 million rows read/day**, **100,000 rows written/day**, **5 GB stored total**. WebSocket application messages bill 20:1 for DO requests; Workers requests are an additional quota. Duration for a continually non-hibernating DO allocated 128 MiB for 24h is ~**10,800 GB-s**. Free limits are shared with other account DOs, including IMA; crossing a limit causes errors, not automatic paid usage.

## Required acceptance gates (do not claim passed)

| Gate | Observable check |
| --- | --- |
| Pairing | missing/wrong Bearer, lookup-only, model-only approval, code substitution, expired/replayed/guessed code, duplicate approve, server-side immutable fingerprint binding, optional local fingerprint comparison and **real-client explicit consent** |
| Identity | Ed25519 Node/Workers interoperability; stolen, wrong or revoked key, replayed challenge, duplicate sockets and failed identity swap; owner and device isolation |
| Operations | original Worker/Agent curated tool contracts, no arbitrary URL, offline rejection, no blind retry, local receipts, bounded file/output and long process sessions |
| Device lifecycle | revoke one device while others run, online best-effort process stop, offline no false termination, reinstall and reconnect with old key denied |
| Linux/WSL2 installer | different home/cloud networks, Node/compiled helper prerequisites, WSL2 startup, restart and network outage |
| Cost and sleep | **1 isolated v2 Preview Agent observed for 48h in nonproduction**, actual DO hibernation and wake, daily DO request/GB-s/SQLite/Workers usage and other DO load, low-frequency reads and controlled reconnect |
| v1 safety | existing VPC/Tunnel unchanged, explicit v2 opt-in, rollback and separate authorization before changing production |

Prefer behavior tests at existing MCP→Worker→Agent seams plus disposable Agent bootstrap/WSS integration; use existing CI **if already available**, but **do not add a CI workflow**.

## Out of scope and deployment controls

No native Windows/macOS Shell, GUI/mouse/screen, general fleet dashboard, OAuth server, Cloudflare One/Mesh/Tunnel per v2 device, multi-tenant DO routing, per-device DO shard, D1/KV/R2, offline queue, forced termination of offline processes, auto-waking sleeping hosts, fake sandbox claims, new CI or changes to live secrets/configuration.

**This spec is design-only.** Do not create Cloudflare resources, provision secrets, install on the real production device, deploy v2 or cut over the working v1 without a separate explicit authorization.

## Official sources

- https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
- https://developers.cloudflare.com/durable-objects/api/state/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/workers/runtime-apis/web-crypto/

### Retry and intentional revocation semantics (2026-10-16; approved UX revision)

- A single **operator-run interactive** command `install-v2.mjs --endpoint https://APPROVED-V2-WORKER/ --name HOST` handles first pairing, recovery of an existing approved identity and **confirmed revoked** identity. There is no `--re-pair` parameter or literal `RE-PAIR` prompt. Agent/WSS reconnect, systemd restarts and unattended activity **never** initiate re-pair. The required independent human approval is the ordinary owner MCP prepare plus a 12-character one-use challenge manually typed on the intended device terminal.
- If an installation has a 0600 private key but no device ID, signed `recoverDeviceId` is attempted first. Verified approval restores the same server ID. Only a definitive unapproved-key 404 permits retrying a pending enrollment with the **same** key, invalidating old pending codes. An existing owned service missing its private key, malformed identity files, or identity conflicts fail closed.
- If a complete key+ID exists and signed recovery succeeds, preserve that key and ID; an already installed owned v2 unit is **not** upgraded/restarted and a different installer Worker `--endpoint` is rejected explicitly. A missing unit can be installed using the same approved identity. A previously approved or revoked public key must never register a pending code directly (409).
- If signed identity recovery is definitively denied (401/403/404), that outcome **alone is not proof of revocation**. The interactive installer checks the old ID and Ed25519 key with a separate short-lived signed **read-only** tombstone probe (`/agent/re-pair/status`). Only the precise old-key/public-key+device-ID record with an irrevocable `revoked` response allows beginning staged **new-key** pairing. Network ambiguity, wrong key, unknown record, malformed response, wrong ID and still-approved identities fail closed without rotating the key.
- After confirmed server revoke, **only the locally invoked installer** stages a fresh 0600 Ed25519 key and displays a new 10-character Base32 pending code (local fingerprint opt-in). A separate authenticated MCP owner review and device-local 12-character challenge signature must succeed before new identity activation. Until then, keep the old revoked key/ID and staged new key separately under owner-only permissions. On success, archive the irrevocably revoked identity, promote the newly paired ID and restart only the **owned v2** systemd user service. A failed or interrupted staging enrollment can be retried with the same command; in-process rename failure rolls back, OS crash mid-promotion requires explicit reconciliation.
- A matching friendly name cannot reinstate an old ID; no reauthorization/un-revocation, Portal Secret transfer, new cloud resource, or implicit production v1 mutation is permitted. Revocation's server-side denial still holds even when an offline/compromised local Agent cannot be confirmed stopped.
