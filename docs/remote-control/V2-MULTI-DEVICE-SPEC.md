# Remote Control MCP v2 — One authoritative multi-device Spec

**Status:** design accepted; source implementation is under [Draft PR #58](https://github.com/lirtual/mcp-workers/pull/58), but production deployment and full multi-device acceptance are **not** authorized. Updated 2026-10-17 (no tombstones under ADR-0017; temporary grants have a fixed 24-hour lifetime under ADR-0018; both implementation changes pending).
Authority: [ADR-0014 — transport](./adr/0014-v2-multi-device-ws-do.md), [ADR-0015 — pairing](./adr/0015-v2-pairing-and-identity.md), [ADR-0017 — device removal](./adr/0017-v2-device-revocation-without-tombstones.md), [ADR-0018 — temporary 24-hour authorization](./adr/0018-v2-temporary-agent-pairing-lifecycle.md). Existing [v1 Spec](./SPEC.md) continues to govern the deployed single-device path.

## Goal

One Remote Control MCP controls separately paired Linux/WSL2 Agents across unrelated networks, with near-one-command installation, explicit per-operation device selection and independent revocation. Reuse the existing native Node.js file/Shell/managed-process implementation and **Agent-local operation receipts**. The v2 Agent opens outbound WSS to one **SQLite-backed Durable Object using WebSocket Hibernation**. No device public IP, port forwarding, Tunnel, Cloudflare One Client or Mesh enrolment for v2.

## Standalone CLI onboarding — accepted user experience, packaging design still open (2026-10-17)

**Accepted owner goal:** Installing and pairing a Remote Control Agent on a new supported device must begin with **one terminal command**, with **no Git clone/checkout, manual workspace dependency installation, local Node.js package preparation, or C compiler setup required of the operator**. Pairing continues through a local interactive CLI. This extends the original near-one-command Linux/WSL2 onboarding goal. It does **not** itself approve a distribution channel, artifact type, unsupported operating system, auto-update policy, or production installation.

**Current gap confirmed in Draft PR #58:** `install-v2.mjs` runs from a trusted checkout and requires Node.js 24, `cc`, compiled `session-supervisor`, and for persistent service mode an accessible systemd user manager. Its service unit points to checkout paths; `--foreground` omits the user unit but still requires the checkout/toolchain and preserves local credentials. The repository has **no GitHub Releases assets** for a standalone Agent as of this review. A thin download script that then clones the repo and builds it on the target **does not** satisfy the user goal.

**Accepted security boundaries:** New-device local identity must be independent per installation; the existing 10-character device pairing code, authenticated owner-side `pairing_lookup` / `pairing_prepare` and signed 12-character local-terminal proof remain required. Do not expose Portal Bearer/admin tokens or store private keys in installer command arguments, logs or release artifacts. Existing `revoke_device` deletion semantics and optional **24-hour temporary authorization** are independent of how the CLI is distributed.

**Decisions still open and NOT to be assumed:** Linux/WSL2-first versus native Windows/macOS feature expansion; installer/download vs prebuilt archive or package-manager transport; portable Node runtime/bundled script/native helper vs single executable; foreground versus installed service defaults and temporary/permanent mode selection; pinned/reproducible releases and artifact integrity, architecture compatibility, offline install/update/uninstall semantics. No new CI workflow, release, binary, deploy or permission change is approved by this UX requirement alone.

## User stories

1. As an owner, I want one straightforward install on Linux/WSL2, so that devices on other networks can join without Cloudflare account setup.
2. As an owner, I want a short locally displayed pairing code, so that I can identify an installation before approving it.
3. As an owner, I want to inspect the device's fingerprint in authenticated MCP, receive a short-lived challenge, and **confirm from the NEW device's local terminal**, so that an autonomous model tool call alone cannot approve it.
4. As an owner, I want `list_devices` with stable IDs and observed status, so that I can target the correct host.
5. As an owner, I want every v2 file/Shell/process command to name its target device, so that concurrent clients cannot redirect actions by changing a default.
6. As an owner, I want disconnected hosts to reject commands, reconnect automatically and reconcile local receipts, so that stale or uncertain mutations are not replayed.
7. As an owner, I want to remove a lost device without harming others, so that its identity and access remain revoked.
8. As an owner, I want online removal to attempt stopping only Agent-owned managed processes, so that the result is accurate without claiming to control an offline host.
9. As an owner, I want reinstallation to require new pairing, so that copied labels/old keys do not inherit authority.
10. As a maintainer, I want 72-hour five-Agent Hibernation and quota evidence and an independent v1 deployment, so that Free costs and rollback are verified before any cutover.

## Minimal changes to existing modules

| Module | v2 work | Reuse |
| --- | --- | --- |
| `apps/remote-control-mcp-worker` | Keep one authenticated `/mcp`, add `list_devices`, `pairing_lookup`, `pairing_prepare`, `revoke_device`, and explicit `device_id` on v2 tool calls; route to DO | Existing Portal auth, curated `LOCAL_TOOLS` schema/validation, error/redaction, operation IDs |
| New v2 owner DO module | Minimal SQLite `pending_pairing` and `device` records; bounded WS dispatch/correlation; atomic device authorization removal without permanent tombstones | Cloudflare DO Hibernation and SQLite; **one DO**, not a fleet platform |
| `apps/remote-control-agent` v2 transport entry | Device-local Ed25519 key, 10-symbol pairing code, outbound WSS, automatic reconnect, local service startup | Existing Linux tool handlers and loopback server can act as v2 execution adapter initially; no duplicated file/Shell engine or new cloud-side receipt storage |
| Existing v1 | **No change in production**; isolated preview/testing until approved cutover | Fixed VPC Service, Tunnel, current credential and worker semantics |

The existing Agent build invokes **`cc`** for its C session-supervisor helper; one-command onboarding must account for supported Node runtime, compiler or version-pinned prebuilt helper, Linux permissions and WSL2 startup. Installing an Agent without handling those prerequisites does **not** satisfy the UX goal. Do not add a new CI workflow merely to package it.

## Stable identities and MCP contracts

- `device_id`: opaque server-issued per-installation identifier; public to authenticated MCP, never based on hostname/IP or user-provided URL. Friendly `name` is untrusted presentation only. Reinstallation creates a new ID/key.
- `operation_id`: existing Agent-local stable mutation identity and receipt; never substitute a WSS correlation identifier. Unknown outcome is `timeout_unknown`, not “failed / safe to retry”.
- `list_devices()` returns bounded **currently approved** `[{device_id,name,status,last_seen_at?}]` only; availability means observed Agent connectivity, not merely network/host state. Removed identities are not returned.
- `pairing_lookup({code})`: Portal-authenticated **read-only** pending device lookup returning `pairing_id`, `name`, `fingerprint`, `expires_at`. Never approves a device.
- `pairing_prepare({pairing_id,expected_fingerprint})`: a separate authenticated MCP preparation action. Confirms the reviewed pending key and returns a **12-character random Base32 challenge (60 bits), one-use, maximum five minutes**. It does **not** approve a device or issue credentials. Owner copies the challenge to the **new device terminal**. A signed local response alone activates identity; a model-generated `approve:true` is rejected.
- `revoke_device({device_id})`: atomically delete durable approval and its outstanding session challenge/epoch **before** any socket or process cleanup; then reject fresh connections/dispatch and close live sockets. Attempt an authenticated internal best-effort stop of owned managed sessions if online, reporting `stop_confirmed`, `stop_unconfirmed` or `offline` honestly. An already absent device is `not_found`, not `already_revoked`. No Cloudflare One registration exists to delete.
- Every v2 existing curated tool adds a validated `device_id` while retaining original tool names/arguments and mutation IDs. No global mutable default. The single-device v1 compatibility route cannot silently pick a v2 target.

**Device removal retention refinement (2026-10-17):** This supersedes earlier permanent-tombstone wording only. Removing a device deletes its authorization; there is no persistent removed-device history or automatic 90-day cleanup. The DO must fail closed on missing records, prevent revoke-vs-login/dispatch races, reject stale WSS sessions, and count **approved** identities against the existing device cap. The current Draft PR #58 still implements tombstones and must be updated and independently tested before this design is claimed complete. Temporary-device authorization follows the owner-approved fixed 24-hour lifetime in ADR-0018; it is not implemented by this documentation update.

## Temporary Debug Device — fixed 24-hour grant (2026-10-17)

Owner revision **Q1: fixed 24-hour validity** (supersedes earlier Q1=C exit-coupled revoke) and **Q2=A: existing independent two-code confirmation** ([ADR-0018](./adr/0018-v2-temporary-agent-pairing-lifecycle.md)). This is a *device authorization lifetime*, not a new lifetime for the pending pairing code or individual development commands.

- **Creation and expiry:** Owner deliberately selects temporary mode as part of new-device pairing. On successful signed, human-confirmed approval, DO records `approved_at` and `expires_at = approved_at + 24 hours` using its server clock, exactly once. Regular permanent identities remain unexpired. Reconnect, activity and ordinary Agent restart never extend this fixed deadline.
- **Pairing security unchanged:** The local 10-character pairing code is still valid **10 minutes**; the MCP-prepared 12-character local challenge is still valid **up to 5 minutes and once**; Ed25519 signed local completion and fresh signed WSS login remain mandatory. `expires_at` applies only after successful device approval. Neither local code is a reusable 24-hour bearer token.
- **Fail closed after expiry:** From `now >= expires_at`, DO must deny new WSS login, identity recovery, and new/previously unadmitted remote dispatch, including via an already-open socket and after Hibernation. Check expiry on server-side authorization paths; never rely on socket-close delivery or the Agent's local clock for enforcement. Revoked/deleted/expired devices are absent from usable `list_devices` results.
- **No exit-triggered revoke:** Foreground exit, Ctrl+C, SIGKILL, WSL suspend, power loss and transient network disconnect do **not** trigger additional remote revocation work or a special grace timer. An offline temporary device can reconnect while its original grant is still valid; after 24 hours it must re-pair explicitly to get a new approved identity. The existing owner-authenticated `revoke_device` remains available for early removal.
- **Storage housekeeping:** Expired approval/nonce/epoch records may be **lazily removed on the next applicable DO access**; no DO alarm, extra Worker, polling job or cleanup scheduler. Physical cleanup may lag past the expiration instant, but authorization may **never** outlive the server deadline. Device-capacity counting must exclude/clear expired grants without being fooled by old 65-entry scans. No permanent tombstone.
- **Already-admitted commands:** Deadline expiry blocks **new commands**, not the effects of writes already applied. Existing Agent-owned managed commands keep their **original absolute 60-minute maximum** and usual safe stop/receipt logic; a process started before expiry may run after expiry until its own deadline or normal termination. Do not promise force-stopping offline work at the exact expiry instant or blindly replaying `timeout_unknown`.
- **Reuse, not new infrastructure:** `install-v2.mjs --foreground` already avoids systemd, but current Draft PR #58 still creates durable device identities without expiration. Explicit temporary mode must avoid accidentally altering a normal installed identity (small separate local identity location if required). No self-revoke endpoint, new Portal/admin secret on Agent, new authentication system, scheduler, CI, or production changes.

**Required validation:** approval at T; reject at T+24h (including an already-open WSS), allow at T+24h−1ms; no sliding lease on reconnect; permanent identity unaffected; DO sleep/wake and stale session fencing; repeated temporary expiration/re-pair and 64-active-device capacity; SIGINT/SIGKILL/network interruption; reliable missing-identity response rather than autonomous re-pair; and truthful in-flight operation receipts. The browser/list view must not claim a physically idle socket has closed exactly at expiration without a wake event.

## Agent-only pairing and authentication (separate from MCP)

1. Installer generates a new **Ed25519** pair locally and a cryptographically uniform **10-character Base32 code (50 random bits)**; displays it locally with **10-minute** expiry. The private key remains device-local with restricted OS permissions.
2. A **bounded public, tool-less Agent bootstrap endpoint** registers a pending code verifier + exact public key/fingerprint in the fixed owner DO. It receives no Shell/file authority. Rate-limit submissions and code guesses, cap outstanding pending requests, expire and clean on access; no general queue or always-on alarm.
3. Owner supplies the code via Portal-authenticated `pairing_lookup`, reviews immutable fingerprint, then uses `pairing_prepare` to receive a short-lived one-use challenge bound to that same pending public key. MCP alone cannot activate a device, and no `pairing_confirm` tool is exposed.
4. The owner manually enters **only the 12-character MCP challenge** on the new device's local terminal/SSH. The Agent retains its original 10-character pairing code in installer memory; it is not retyped. Its private key signs a domain-separated transcript binding pending code verifier, challenge and the immutable public key. The public, tool-less `/agent/pair/complete` endpoint verifies one-use challenge and signature, atomically consumes pending approval and issues a device ID. **This pairing proof is not a WSS login.** Later a fresh independent server nonce signs the authenticated operational `wss` session in #50. Never put long-lived keys, code or Portal Bearer into query strings/logs.
5. Every subsequent WSS reconnect uses a new challenge and the same approved local private key. Verify current SQLite authorization at connection and before **each command dispatch**, including after Hibernation wake. Use a deterministic per-device connection epoch to fence duplicate old sockets. Removal permanently invalidates the old `device_id`; no old authorization survives. Without historical key blacklists the same old public key can still submit a **new pending pairing request**, which has no operational authority until full independent owner/device approval.

**Security gate (refined 2026-10-16):** static Portal Bearer authenticates caller possession, not an actual human. The owner approved an independent **new-device terminal confirmation** to prevent autonomous MCP-only approval without adding OAuth or a dashboard. This is independent **only if ChatGPT and its other authorized tools cannot operate that terminal or access the new private key**. A compromised target/SSH session is not proof of a separate human; do not claim universal human-presence verification. Validate actual client/host boundaries before production.

## Device control and failure model

- Only authenticated MCP can request curated operations; only an approved, currently authorized Agent socket receives them. Agent independently validates operations and its OS permissions. Public bootstrap never executes tools.
- One short-lived WSS message envelope: `{version,type,request_id,device_id,operation_id?,tool?,arguments?,result?}`. Validate size/tool/schema and bind device identity on both ends; responses must match the initiating request ID and connection epoch. No arbitrary target host/URL, generic proxy, or cloud file/command-output archive.
- Short/read calls and acknowledgement of long-running `start_process` use **bounded RPC deadlines**. Extended processes run only under the Agent's existing managed-session contract. Do not await a multi-minute Shell command inside a DO request/promise: it prevents Hibernation.
- A known disconnection immediately marks offline; a silent partition has a bounded detection delay (must be measured, not claimed instantaneous). Auto reconnects with backoff, no queued commands and **no resubmission of uncertain mutations**. Status can be reconciled with the same `device_id + operation_id` after reconnection.
- An ordinary network loss **does not stop** an Agent-owned running process. Explicit removal denies new work first, attempts stopping *owned* sessions via a narrow internal control when possible and then closes the connection; an offline/compromised device's process may continue.
- WSL2 may be stopped while its Windows host is online; only actual Linux Agent reachability counts as “online.” Automatic start across Windows host reboot/WSL2 shutdown must be tested and must not be asserted by design alone.

## Hibernation, persistent state and Free quota

- The **SQLite-backed owner DO** stores minimal `pending_pairing` (code verifier, public key, 10-minute expiry, status, attempts) and `device` (approved opaque ID, key, label, approval time, temporary/permanent type and optional fixed 24-hour expiry) records. Deny expired grants immediately in authorization; lazily remove expired/revoked device grants and associated session state, with no permanent history or extra D1/KV/R2.
- Use `ctx.acceptWebSocket()`, connection `serializeAttachment()`/`deserializeAttachment()` and `getWebSockets()`; attachments hold **nonsecret** `device_id`/epoch, but **SQLite** remains authoritative after DO eviction or code deployment.
- DO Hibernation requires *no scheduled `setInterval`/`setTimeout`*, no unbounded `waitUntil` or held-open outgoing I/O. Prefer protocol ping/pong or Cloudflare automatic WS responses; **frequent application-layer heartbeats on multiple devices can keep the one DO awake**. Read auto-response timestamps when requested and use measured offline detection, not a busy poller.
- Verified official Workers Free SQLite-DO limits: **100,000 DO request-billing units/day**, **13,000 GB-s/day**, **5 million rows read/day**, **100,000 rows written/day**, **5 GB stored total**. WebSocket application messages bill 20:1 for DO requests; Workers requests are an additional quota. Duration for a continually non-hibernating DO allocated 128 MiB for 24h is ~**10,800 GB-s**. Free limits are shared with other account DOs, including IMA; crossing a limit causes errors, not automatic paid usage.

## Required acceptance gates (do not claim passed)

| Gate | Observable check |
| --- | --- |
| Pairing | missing/wrong Bearer, lookup-only, model-only approval, code substitution, expired/replayed/guessed code, duplicate approve and immutable fingerprint binding; **real-client explicit consent** |
| Identity | Ed25519 Node/Workers interoperability; stolen, wrong or revoked key, replayed challenge, duplicate sockets and failed identity swap; owner and device isolation |
| Operations | original Worker/Agent curated tool contracts, no arbitrary URL, offline rejection, no blind retry, local receipts, bounded file/output and long process sessions |
| Device lifecycle | revoke one device while others run, deleted identity cannot reconnect or dispatch even with stale WSS, online best-effort process stop, offline no false termination, repeated removals do not exhaust the 64-active-device cap, and any fresh pairing requires independent owner confirmation |
| Temporary 24-hour grant | server-clock 24h from approved pairing; deny after expiry even with old authenticated WSS; no renewal on reconnect, no requirement for on-exit self revoke, lazy expired-record pruning without active-device cap leakage, and honest in-flight 60-minute Shell/receipt handling |
| Linux/WSL2 installer | different home/cloud networks, Node/compiled helper prerequisites, WSL2 startup, restart and network outage |
| Cost and sleep | **5 simulated independent Agents continuously connected 72h in nonproduction**, actual DO hibernation and wake, daily DO request/GB-s/SQLite/Workers usage and other DO load, traffic bursts and fail/reconnect |
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
