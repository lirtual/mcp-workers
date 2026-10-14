# ADR-0018 — Select v2 Agent-initiated WebSocket + Durable Objects with Portal-approved one-time pairing

Status: **accepted as future v2 DESIGN; implementation, pairing-protocol details and production release NOT approved**.
Date: 2026-10-15. Decision inputs: grilling Q14=A, Q15=A, Q16=A.
Scope: Remote Control MCP's new multi-device v2 only. Current production single-device v1, its VPC Service/Tunnel, device token and ADR-0004/0012/0013 remain intact.

## Context

The owner needs low-friction installation on Linux hosts and WSL2 environments in unrelated home, office and cloud networks. A single MCP entrypoint should list and target devices by stable `device_id`. The system must preserve Agent-owned operation receipts, no blind retry, offline reject and automatic reconnection; reinstall must re-pair and independently revoke old identity. The owner requires first-release device-specific revocation of all privileges actually granted, with best-effort cancellation of online Agent-owned sessions on explicit removal (ADR-0015/0016/0017).

Prior research found Cloudflare Mesh + Workers VPC Network supports cross-network reachability, but durable refusal of one interactive device's re-enrollment while the same user can enroll other devices was not verified. A fixed per-site Tunnel also complicates one-step installation across independent networks. The user now explicitly selects an Agent-initiated WebSocket design.

## Accepted decisions

1. **Q14=A — v2 transport:** Design v2 around a device-initiated authenticated TLS WebSocket (`wss`) to a Cloudflare Worker using a **SQLite-backed Durable Object with WebSocket Hibernation**. Keep the Agent's native Node.js file/search/Shell functions, local idempotent `operation_id` receipts and managed sessions. The Worker remains the only public MCP entrypoint; the Agent exposes no public device-control HTTP endpoint, fixed Tunnel or direct port forwarding for v2. A single logical owner DO coordinating a small personal device set is the default direction; do not create per-device DO shards, D1, R2, KV, generic event queues or a fleet-control platform absent measured need.
2. **Q15=A — existing MCP Portal owner authorization:** Reuse Remote Control's independently provisioned `MCP_ACCESS_TOKEN` and `@mcp-workers/portal-auth` at the authenticated **MCP approval/control boundary**. The owner must explicitly approve a specific pending device pairing; unauthorized or omitted confirmation fails closed. The Bearer token proves possession, **not** a logged-in human identity or an OAuth grant; do not claim Cloudflare One/Cloudflare Access login or automatic human verification. A model-initiated tool call and ChatGPT platform tool-authorization UI alone are **not** proof of physical owner intent. Define and test an explicit user-confirmation handshake in the next protocol decision.
3. **Q16=A — installation/pairing UX:** A Linux/WSL2 installer shows a **short-lived one-time pairing code** locally. The owner enters the code into the MCP-side pairing/approval flow and explicitly confirms the intended device. Only after successful confirmation does the Agent retain an **independent per-installation device credential**, without the user manually copying `REMOTE_CONTROL_DEVICE_TOKEN`, `MCP_ACCESS_TOKEN`, Cloudflare administrator credentials or a shared Service Token to a device. On reinstall, generate new identity and re-pair; do not trust the same hostname/OS user or a previously backed-up token.
4. **Q11/Q5 — revoke actual credentials:** For this non-Mesh v2 design, no Cloudflare One device enrollment is created. Device removal must immediately persistently deny its app credential, reject fresh WS upgrades and pending/new commands, and close its active WebSocket; online Agent-owned sessions receive a best-effort stop request. No Cloudflare One registration exists to revoke, and none is created merely for the sake of removing it.
5. **Q12 — v1 isolation:** Develop and test v2 separately; v1 remains operational and unchanged until the owner independently authorizes a rollback-safe production cutover. Maintaining two versions during transition must not require registering a second permanent user-facing MCP plugin.
6. **Release gating:** This ADR accepts the **architecture choice**, not the safety or availability claims of an unbuilt system. Implementing new public pairing endpoints, test deployments, production Worker/Agent modifications and new Secrets each require their own approved phase. No production rollout is permitted until the explicit proof gates below pass.

## Protocol decisions accepted afterward — 2026-10-15

[ADR-0019](./0019-pairing-code-device-keys-and-72-hour-gate.md) settles the seventh-round defaults that were open when this document was written:

- **Q17=A:** separate Portal-authenticated lookup/review and explicit approve of the same pending device fingerprint; real-client confirmation/human-intent proof remains a blocking acceptance test.
- **Q18=A:** a single-use **10-character random Base32 (50-bit) code**, expiring after **10 minutes**, never reused or treated as a long-lived credential.
- **Q19=A:** the fresh installation creates its own private/public keypair and authenticates with a fresh signed challenge, not a shared per-device Bearer.
- **Q20=A:** five simulated Agents for **72 continuous hours** in nonproduction with Hibernation, quota, reconnect and recovery evidence required for release.

The [lean v2 technical Spec](../V2-MULTI-DEVICE-SPEC.md) records minimal interfaces and test seams. Any earlier mention of an unchosen pairing duration, device-credential type or 24–72h soak in this ADR is now historical and subordinate to ADR-0019. No v2 code, Cloudflare resources, CI or production change is authorized.

## Essential security invariants — protocol specifics still to be agreed

- Separate caller/MCP ingress token, pairing bootstrap code and long-lived device key. Never send the Portal Bearer to Agent or log it, and never treat the one-time code as a permanent device secret.
- **Authenticate both directions:** prevent an unauthorized caller from approving a device, and prevent an unapproved Agent from executing anything. Enrollment/bootstrap endpoints may need to be publicly reachable for Agents without a Portal token: they must be strictly tool-less, bounded, rate-limited, time-limited and incapable of routing Shell/file requests until paired. Do not simply expose `/mcp` without authentication to make pairing work.
- Bind pairing to one generated device-held credential or public key, a server-held pending enrollment, an owner confirmation and one-time redemption; ensure collision/replay/expiry/race tests. A guessed/leaked short code alone must not yield execution privilege.
- Stable random `device_id`, not hostname, IP address or client-supplied URL, is the authorization and routing key. Reject revoked, unpaired, offline, wrong-device and concurrent duplicate/superseded connection state.
- Persist authorizations, revocations, pending pairing state and minimal device metadata durably (SQLite-backed DO storage), not solely in JS maps/WebSocket attachments. Restore connection metadata on hibernation wake using `deserializeAttachment()` and re-check persistent authorization upon reconnect and **before dispatch**; active WebSockets do not supersede a revocation tombstone.
- No offline command queue or automatic mutation replay. Bound request/response waiting and use existing Agent receipts for ambiguous outcomes. On explicit revoke, mark denied first, best-effort ask online Agent to stop owned sessions, close the connection; never claim offline/local jobs stopped without evidence.
- Device-initiated `wss` needs no Cloudflare One device login by default. Q3's previously accepted *Cloudflare One interactive/headless enrollment* concerns the Mesh alternative only; this selected design relies on owner-approved application pairing instead. An independent Cloudflare Access sign-in is **not** approved.

## Required deployment/acceptance gates (not yet satisfied)

1. **Owner/Agent pairing:** make a short-lived local code, explicit owner approval through existing Portal auth, one-time redemption with device proof, high-entropy per-device long-lived identity, expiry, rate limits and protection against enumeration, replay, substitution, leaked code, stolen key and forged MCP/Agent requests. Confirm genuine user intent cannot be assumed merely from valid Bearer or model-suggested tool calls. Exact code length, owner UX, key type and TTL remain open.
2. **Linux/WSL2 installation:** disposable Linux and WSL2 hosts in at least two separate networks; no inbound ports/Tunnel/Cloudflare One requirement; service auto-reconnect and restart behavior; WSL2 shutdown distinctly shown as offline. No permanent production changes.
3. **Transport correctness:** `ctx.acceptWebSocket()`, `webSocketMessage`/`webSocketClose`, WebSocket connection attachments and hibernation/wake; duplicate connections, network cut, Worker/DO restart/deploy, backpressure, payload caps, slow and parallel calls, unknown result and receipt reconciliation. Do not use standard `ws.accept()` or keep unresolved requests/timers running indefinitely.
4. **Revocation:** persisted deny before network close, reconnect and token reuse rejected, one device removed without affecting others, best-effort online session stop outcome recorded, offline host cannot be certified terminated, reinstall new identity. No Cloudflare One enrollment needed/issued in this architecture.
5. **Workers Free / DO Free:** perform 24–72-hour *nonproduction* test with at least 5 idle connections, representative messages, and realistic mixed read/write/Shell traffic. Record actual DO requests, billable duration, SQLite reads/writes/storage and Workers requests; account for other DO consumers. Verify Hibernation actually occurs with no unexpected billing when idle. A Free-plan quota failure must be visible/unavailable, not a spurious mutation retry.
6. **Compatibility/cutover:** current v1 remains healthy, v2 explicit target selection works with one MCP interface, no confusing implicit default device, rollback and explicit owner approval prior to any production switch.

## Consequences

**Advantages:** one installed Agent (no per-host Cloudflare One Client, tunnel or admin token required), one authenticated MCP interface, direct per-device revocation semantics, and Linux execution/receipt reuse. Removing the Mesh network-registration lifecycle also avoids the unresolved same-user re-enrollment issue.

**Costs:** implement and secure the public Agent bootstrap surface, owner approval, session routing, device credential lifecycle, bounded RPC correlation and Hibernation-aware persisted state. Free allowances are bounded and shared across account workloads. An application-denied compromised/offline Agent may keep running already spawned processes locally.

## Rejected or deferred

- Mesh + VPC Network for v2 primary transport: deferred because its device-specific permanent re-enrollment denial is unproved and client/enrollment lifecycle makes one-step installation heavier. This does **not** invalidate v1 VPC Service + Tunnel.
- One shared `REMOTE_CONTROL_DEVICE_TOKEN` or an admin Cloudflare token in installer; automatic approval on installation; anonymous remote Shell; per-device DO/D1/KV/R2 before justified; native Windows/macOS execution in the first v2 installer.

## Primary evidence

- https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/durable-objects/platform/limits/
- https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/device-registration/
- [Existing ingress auth implementation](../../../packages/portal-auth/src/index.ts)
- [ADR-0017](./0017-multi-device-revocation-semantics-and-transport-gates.md)
