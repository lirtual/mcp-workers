# ADR-0017 — Multi-device revocation semantics, v1 coexistence, and transport selection gates

Status: **Q11/Q12/Q13 accepted as requirements; transport is PROPOSED ONLY, not accepted**.
Date: 2026-10-14. Grilling decisions: Q11=A, Q12=A, Q13=A.
Scope: future Remote Control MCP multi-device v2; not the currently deployed v1 Worker/Agent.

## Context

ADR-0014 establishes Linux/WSL2-first easy installation and permits automated Cloudflare One Client setup. ADR-0015 requires owner-approved, individually revocable device credentials, `list_devices`, explicit `device_id`, and single-action first-release removal of every access permission actually granted. ADR-0016 requires fail-closed removal, no offline command queue, local operation receipts, no blind replay and new identity on reinstall.

Candidate transports: (1) Cloudflare Mesh + one Workers VPC Network binding, reusing the existing private HTTP Agent interface; (2) Agent-initiated authenticated WebSocket to a Worker/Durable Object with WebSocket Hibernation, with local Agent execution preserved. One site Tunnel cannot itself directly reach unrelated networks without further connectivity.

## Accepted decisions

1. **Q11=A — Revoke all permissions that this architecture actually granted.** The owner's Q5=B requirement is strong, device-scoped and automatic, but **does not require manufacturing a Cloudflare One/Mesh device registration** for a design which does not use Mesh. For Mesh, a removal is only complete when MCP authorization and Cloudflare One enrollment/network privileges of the target are permanently denied, including prevention of automatic re-enrollment. For WS+DO without Cloudflare One enrollment, removal must persistently invalidate that Agent's application credential, reject any future connection or operation, and actively close any still-attached WebSocket; there is no Cloudflare One registration to delete. Report partial failure honestly.
2. **Q12=A — Keep production v1 isolated.** Continue the working single-host Worker → fixed VPC Service → private Tunnel → Linux Agent deployment unchanged. Design/build/prove v2 separately, opt in and migrate only after explicit acceptance, reversible cutover plan and distinct production authorization. Do not alter the accepted v1 ADR-0004/0012/0013 for a speculative transport.
3. **Q13=A — Explicit removal vs ordinary disconnection.** On removal, server-side authorization deny/tombstone is immediately effective and takes precedence over connection/route state; no new tool call or reconnect may be admitted. If online, the system sends an authenticated best-effort stop request for the Agent's *owned managed sessions only* and closes its network transport; no arbitrary host PID killing. An offline or compromised Agent may continue previously launched work, so never promise remote kill succeeded without an Agent receipt. Q8=A still means *ordinary connection loss alone* does not terminate running operations, and no mutation is automatically retried after unknown outcome.
4. **Cloudflare identity compatibility boundary:** Q3=A interactive Cloudflare user login and authorized headless Service Auth were accepted *for a Cloudflare One/Mesh enrollment transport*. Q1=A permits but does not mandate installing One Client. A WS+DO transport **does not automatically provide Cloudflare One Login, Cloudflare Access login, Portal/ChatGPT OAuth, or identity-provider authentication**. Owner approval and per-Agent pairing remain mandatory, and any new browser auth/login should be explicitly selected later; reuse the existing distinct `MCP_ACCESS_TOKEN` for authenticated **MCP ingress only** and never put that token or privileged Cloudflare account API credentials into the Agent installer.
5. **Pairing UX still open:** A candidate is a short-lived one-time bootstrap with explicit owner approval and separately generated per-device key, exchanged over authenticated TLS, then permanently stored under restrictive OS permissions; reject expired/replayed pairing grants. This is a **proposal requiring later approval and abuse/security testing**, not an accepted passwordless auto-approval design. Disallow arbitrary anonymous public Shell. Do not claim an unsigned browser popup is enough.

## Evidence-based transport convergence — PROVISIONAL, NOT AUTHORIZED

### Mesh + VPC Network

- Cloudflare documents that `network_id: "cf1:network"` lets a Worker reach Mesh IPs and other private destinations across networks. Workers VPC and Mesh currently include Free/Beta availability, but future GA pricing/features may change.
- Cloudflare One device registration documentation states that deleting/revoking a registration or a device does not prevent re-registration when the same interactive user or service token remains eligible. Enrollment policies do not support pre-enrollment device posture checks. For the same person enrolling several machines, a published, tested **per-physical-device** and **persistent no-reenrollment** solution (without removing that person's other devices) has not been established.
- For headless servers, per-device Service Tokens + policy cleanup are plausible, but add Cloudflare control-plane credential issuance, scope, expiry, policy and API lifecycle; a token shared by all devices does not satisfy Q5. Distinct service-token deletion alone cannot substitute for removal of its policy grant and registration.
- Therefore Mesh remains a conditional candidate only if the exact security gate is demonstrated on disposable devices without production changes. Merely authenticating a Mesh node or deleting one registration is insufficient.

### Agent-initiated WebSocket + SQLite Durable Objects

- It directly supports independently authorized outbound device sessions without Cloudflare One network enrollment; an application-owned `device_id` + revocable credential can be checked on both initial WebSocket upgrade and every command dispatch, independently from transient socket/connection state. **Credential revocation is not the same as terminating previously launched local processes.**
- Preserve existing native Linux file/search/Shell implementation, local `operation_id` receipts and managed-session ownership. Replace only transport and add minimal pairing, registry and request/response correlation; no new general-purpose task queue, D1, KV or R2 until demonstrated necessary.
- Use **Durable Object WebSocket Hibernation API** (e.g. `ctx.acceptWebSocket()`), not Standard `ws.accept()`; do not keep DO awake with loops, pending I/O or timers. Connection metadata/auth state must survive hibernation/wake; no reliance on JS in-memory maps for persistent revocation. On a WS reconnect, discard stale request dispatches; never queue unknown Shell commands to run later.
- Since each MCP call may outlive an individual edge request, status reconciliation must have a bounded wait and `timeout_unknown`/receipt result; no held-open promise is allowed to silently turn an otherwise hibernating DO into an always-on billed object.

## Workers Free / Durable Objects Free verified figures (2026-10-14)

Official DO pricing (https://developers.cloudflare.com/durable-objects/platform/pricing/):
- Free supports **only SQLite-backed Durable Objects**, **100,000 billable DO requests/day**, **13,000 GB-s duration/day**, **5 million SQLite rows read/day**, **100,000 rows written/day**, **5 GB total SQLite stored data**. These are account-level shared limits, not per device. Free-plan excess operations of a category error instead of automatically being charged. Daily quotas reset at 00:00 UTC.
- DO requests include WebSocket connection establishment, RPC and alarm invocations. **Inbound WebSocket application messages count 20:1 for compute request billing**; outbound messages and incoming protocol ping frames are not charged as DO compute requests. A normal Worker front-end has its own separate Workers Free limits, including 100,000 requests/day, so budget both.
- Duration uses an **allocated 128 MiB memory** basis and wall clock while active/not hibernation-eligible. One DO continuously non-hibernating for 24 hours ≈ **10,800 GB-s** (`86400s × 0.125GB`), ~83% of daily free duration, before other DO workloads; two such DOs ≈ 21,600 GB-s and exceed the free quota. DO that qualifies for hibernation while idle does not incur wall-clock duration charges.
- Example **5 Agents × 1 app-level inbound message/30 sec × 24h = 14,400 messages/day, ~720 billed DO requests/day** for messages only (not counting 5 connection opens, Worker requests, RPCs, auth/provisioning, durable reads/writes or active duration). This is not a benchmark; protocol-level ping/pong can avoid waking DO and is not counted as application messages.
- Watch combined account usage because the existing IMA Worker may also use DO. Verify current authoritative cloud consumption before assuming free headroom. The lack of charge does **not** mean the runtime is unlimited.
- Workers Free CPU limits and incoming WebSocket upgrade quotas still apply. Avoid asserting unlimited permanently open sockets. Test no-op idle 24–72 hour duration/hibernate behavior with multiple Linux/WSL2 Agents in nonproduction before commitment.

## Recommendation (requires explicit owner acceptance)

**Prefer WS + DO Hibernation for v2 transport design** on the evidence currently available: cross-network single-Agent onboarding, independently revocable device identity, no per-device Cloudflare One enrollment and fewer secrets/clients on device. Keep Mesh+VPC as a reference/secondary candidate until its physical-device irrevocability gate is proved. This preference is **not** selection authorization, implementation authorization, or permission to change v1.

## Hard acceptance gates before changing architecture status

1. **Identity/pairing:** define exact owner login/approval flow for UI device + headless Linux that matches Q3/Q4/Q11, includes replay protection, per-device revoke and no credential logging; prove invalid credentials and unrelated devices are rejected. Decide whether Cloudflare One login remains a user-facing requirement when Mesh is not used.
2. **Offline/mutation:** install Linux + WSL2 (host lifecycle), 2+ independent networks, offline/return, request timeout, replayed operation ID, reconnect after revocation, lost/compromised device, best-effort terminate receipt.
3. **Cost and hibernation:** show DO hibernation and Free usage for 5+ idle devices, 24–72h under realistic connection/heartbeat traffic. The production IMA DO share must be considered.
4. **Migration:** current single-device v1 remains healthy. Prove opt-in v2 tool names/targeting, no ambiguous default device, reversible cutover and explicit owner authorization to deploy or switch.
5. **Mesh alternative:** if Mesh remains in scope, provide disposable same-user two-device experiment demonstrating deletion + **no automatic re-enrollment** only for target, and distinct headless token/policy cleanup.

## Consequences

Benefits: security requirement can be achieved at the application's actual credential boundary; v1 untouched; simplified per-device installation if WS+DO wins.
Costs: WS+DO adds bespoke session/request correlation, pairing and DO state/cost monitoring; no Cloudflare One network protection is inherited; permanent app authorization denial alone cannot stop offline OS commands already started. Selection awaits user agreement and evidence.

## Sources

- https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/device-registration/
- https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/deployment/device-enrollment/
- https://developers.cloudflare.com/cloudflare-one/tutorials/deploy-client-headless-linux/
- https://developers.cloudflare.com/workers-vpc/examples/connect-to-cloudflare-mesh/
- https://developers.cloudflare.com/workers-vpc/configuration/vpc-networks/
- https://developers.cloudflare.com/mesh/platform/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/durable-objects/platform/limits/
- https://developers.cloudflare.com/durable-objects/best-practices/websockets/
