# Multi-device architecture evaluation — evidence and decision gate

Status: **discovery / proposed architecture, not accepted**. Evaluated: 2026-10-14.
Links: [Domain context](./CONTEXT.md), [ADR-0014](./adr/0014-linux-first-one-client-onboarding.md), [ADR-0015](./adr/0015-per-device-pairing-and-revocation.md), [ADR-0016](./adr/0016-device-lifecycle-and-recovery.md).
**This is a documentation-only comparison, not a Cloudflare account/prototype test.** Q11/Q12/Q13 accepted, transport not yet accepted; see [ADR-0017](./adr/0017-multi-device-revocation-semantics-and-transport-gates.md).

## Final design-direction update — 2026-10-15

Owner-approved sixth-round decisions: **Q14=A** selects Agent-initiated WS + SQLite-backed DO Hibernation as v2's transport **design**, **Q15=A** reuses the existing MCP Portal Bearer for an explicit, device-specific owner pairing approval, and **Q16=A** has the installer display a short-lived one-use pairing code entered/confirmed through MCP. See [ADR-0018](./adr/0018-v2-websocket-do-transport-and-portal-pairing.md) and [pairing and Hibernation acceptance plan](./V2-PAIRING-AND-HIBERNATION-ACCEPTANCE.md).

The following provisional comparisons and earlier unresolved Q11/Q14 questions are retained **as historical research**, not live decision blockers. Selected architecture is **not** the same as passing security, Free-tier or production validation. One existing production v1 VPC Service + Tunnel continues untouched. Cloudflare One login is not used by the chosen WS/DO network path and is not provided by existing static Portal Bearer authentication.

## Fixed owner requirements

- Linux and WSL2 first; devices spread across home, office and cloud networks, one MCP endpoint and explicit `device_id`.
- Installer may handle Cloudflare One Client automatically (Q1=A), interactive Cloudflare login for desktop and approved unattended enrollment for headless hosts (Q3=A).
- Device must separately pair with an independently revocable MCP identity (Q4=A).
- First multi-device release must have one owner-facing operation that revokes **MCP authorization plus per-device Cloudflare network permission** if Cloudflare One/Mesh is used, with no automatic re-enrollment (Q5=B).
- Offline: no new queued work, automatic reconnect (Q7=A). Local receipts and no blind retry; running command need not stop on ordinary disconnection (Q8=A).
- Reinstall = new identity and pairing, old revoked (Q9=A); on Cloudflare cleanup error deny MCP immediately, retry cleanup and show pending (Q10=A).

## Verified from current Cloudflare documentation

1. **Mesh + VPC routing: supported on paper.** A single Workers VPC Network binding to `network_id: "cf1:network"` can address Mesh participant IPs and services across connected networks without per-device VPC Service registrations. Workers VPC is Beta and currently free; Mesh is Beta and available on Cloudflare One Free. Mesh routing is IP based today. Reaching a WSL2 Linux Agent from a Windows-host Cloudflare One Client requires an explicit local forwarding/listener/firewall proof; a running host-side client does not prove a Linux Agent is reachable.
2. **Interactive identity revocation: blocking weakness.** Cloudflare's registration lifecycle says deleting/revoking a registration or physical-device record does *not* permanently exclude that machine when the same user or service token remains authorized for device enrollment; the client can automatically create another registration. Removing an interactive *user* from enrollment policies/IdP may affect that user's **other** devices. Enrollment-time posture checks are not supported. We have **not found a documented per-physical-device immutable re-enrollment denial mechanism** that guarantees Q5=B while the same user can enroll other computers. This is a negative evidence assessment, **not proof that no private or future mechanism exists**.
3. **Headless token revocation: feasible components, not complete proof.** Cloudflare's documented headless Linux flow uses an Access Service Token; a unique token per device is supported as a provisioning choice. The removal flow requires eliminating the relevant enrollment policy grant **before** deleting the registration; a Service Token cannot be deleted while it remains attached to a device enrollment policy. Sharing one token across devices makes independent revocation harder. A real API/policy and re-enrollment test is needed.
4. **Cloudflare control-plane permissions**: individual registration deletion accepts `Zero Trust Write`; service-token deletion accepts `Access: Service Tokens Write`. Neither API request success alone proves permanent per-device removal.
5. **WS + Durable Objects Hibernation**: Agent initiates a TLS WebSocket to a public authenticated Worker/DO endpoint, without a Cloudflare One Client/Mesh network. It offers direct per-Agent credential issuance/denial and device-specific WebSocket closure; DO can hibernate while keeping connections open and restore connection metadata with WebSocket attachments. It requires bespoke pairing, reconnect, delivery correlation, and state/mutation safeguards. Existing local `operation_id`/receipts remain Agent-owned. Free plan supports SQLite-backed DOs, with request/duration/storage caps. This design **does not revoke a Cloudflare One device registration**, because none is required: whether that satisfies Q3/Q5's meaning of “Cloudflare authorization” is an unresolved owner decision.

## Trade-off summary

| Criterion | Mesh + VPC Network | Agent WS + Hibernating DO |
| --- | --- | --- |
| Different home/office/cloud networks | Docs support, subject to actual routes | Natural outbound TLS WS from each host, to be tested |
| Installer components | Cloudflare One Client plus Linux Agent; WSL2 host + guest coordination | One Linux Agent; no One Client needed for transport |
| Reuse existing HTTP Agent/Worker seam | Strong reuse | Tool and local execution can be reused; networking rewritten |
| Cloudflare policy/registration overhead | Individual enrollment/identity/API-policy lifecycle | No network enrollment; custom app pairing/registry |
| Per-device permanent Q5=B network revocation with same interactive user | **Unproven/blocker**; delete may re-enroll | Not applicable as Cloudflare One network access is absent; application-layer revocation is controllable if server denies and WebSocket reconnect is rejected |
| Offline/mutations | HTTP unreachable; local receipt query on reconnect | WS lost; local receipt query on reconnect |
| Operating cost | Workers VPC/Mesh Beta currently free; client/device management | DO Free allowances and Hibernation discipline; request/message/duration consumption |
| New failure/complexity | Cloudflare enrollment and policy permission automation, local Mesh reachability | Messaging protocol, connection identities and rebind, DO lifecycle |
| Risk | Broad Mesh network surface; never trust caller-selected IP | Public WS endpoint attack surface; strong pairing auth and rate limits essential |

## Provisional architecture recommendation (NOT accepted)

**Do not commit to Mesh for the first multi-device release solely because its cross-network routing works.** Q5=B is an explicit first-release security acceptance gate. The *interactive user per-device no-re-enrollment* problem must be solved and proven without revoking that user's other devices.

Recommended next step is a **small evidence-driven transport decision**, not a management framework:

- **Gate M1 — Mesh routing:** on harmless test agents with no production modification, check cross-network Worker -> Mesh IP -> Agent HTTP and WSL2 host forwarding. Use fixed server-side destination records, no arbitrary URL.
- **Gate M2 — Mesh removal:** create a disposable interactive registration plus at least one other surviving device under the same Cloudflare login; delete/deny the target using documented APIs, attempt re-authentication and verify it cannot regain Cloudflare network access *without disabling the other device*. Repeat with per-device headless Service Token and enrollment-policy cleanup. If M2 fails, Mesh **cannot be accepted as-is** under Q5=B.
- **Gate W1 — WS/DO:** independently evaluate Agent-initiated authenticated WS, DO hibernation, per-device revoke/reconnect rejection, free-plan spend and local receipt reconciliation. Device must never run a new queued command after reconnect.
- **Decision interpretation:** if Q5=B is literally “revoke a Cloudflare One client/registration for every device” even when not using Mesh, WS/DO alone **does not satisfy it**; clarify the acceptance condition instead of silently dropping Q5. If Q5=B is “revoke all Cloudflare-related permissions actually granted to the device,” with no Cloudflare One network grant in the WS design, WS/DO becomes the stronger **provisional preferred candidate** for simple installation and durable device-scoped application authorization.
- **Migration:** preserve the current v1 single VPC Service + Tunnel until a tested installation, explicit owner transport decision, rollback and production cutover authorization. No blind rewriting of earlier accepted ADRs.

## Accepted round-five convergence — 2026-10-14

**Q11=A:** Every device must lose all credentials/network access **actually granted by the selected architecture**. For WS+DO there is no Mesh registration to delete, so require permanent application-credential denial, immediate rejection of any new messages/reconnect, and close any attached WS. For Mesh, remove the Cloudflare One device's enrollment and permanently prevent re-registration without touching other devices. This resolves the previous Q11 question; do not require Cloudflare One installation for WS+DO.

**Q12=A:** Leave the existing production single-device VPC Service + Tunnel and its Agent unchanged. Build the v2 path separately, test and obtain explicit migration/cutover approval.

**Q13=A:** Immediate deny on explicit device revocation, plus authenticated **best-effort** cancellation of Agent-owned sessions when online. Offline/compromised hosts may continue existing local processes; do not falsely state all jobs stopped. Ordinary network loss remains Q8=A (keep local operations running; reconcile by receipts).

### Cloudflare One login/pairing compatibility

- Q3=A is specifically the **Cloudflare One/Mesh device-network enrollment option**: interactive owner login where a UI exists, authorized headless Service Auth otherwise. Installation is not permission to execute commands; separately pair each Agent (Q4=A).
- WS+DO does not enroll the device in Cloudflare One and does **not** provide Cloudflare One login or ChatGPT OAuth by itself. It needs an **owner-approved application pairing mechanism**. Candidate design, **not accepted yet**: device obtains a time-limited one-time pairing challenge; owner approves through a separately authorized management surface; Agent receives its own bound credential/key (not MCP ingress token), persists it in OS-protected storage; server enforces identity on WS upgrade and every operation and refuses an old key immediately after revocation. Rate-limit pairing and prevent bootstrap replay and token leakage.
- Keep existing ingress `MCP_ACCESS_TOKEN` scope at the MCP Worker and separate it from Agent pairing; neither an administrator Cloudflare API token nor that MCP ingress token goes into a public install command. A Cloudflare Access identity/login screen could be added to a pairing UI, but doing so is a **new** choice with extra deployment prerequisites, not assumed.

### Cloudflare Free budget / constraints — official pricing as of 2026-10-14

Source: https://developers.cloudflare.com/durable-objects/platform/pricing/

- Workers Free supports **SQLite-backed DO only**; free allocation **100,000 DO requests/day; 13,000 GB-s/day** duration. It also includes SQLite storage **5,000,000 rows read/day; 100,000 rows written/day; 5 GB stored**. Exceeding any dimension on Free errors out rather than automatically charging extra. Daily quotas reset at 00:00 UTC.
- Inbound **application WebSocket messages are billed at a 20:1 ratio** for DO compute requests; connection creations, RPCs, alarms and HTTP requests also count. Outbound WS messages and incoming protocol ping frames are not charged as DO compute requests. Workers frontend requests use their own separate Free quota.
- DO's duration is wall-clock while active/non-hibernation-eligible, at a **128 MiB** allocation. A single DO stuck awake for 24 hours is ~10,800 GB-s, or ~83% of the daily Free duration; two such DOs already exceed 13,000 GB-s. Correct `ctx.acceptWebSocket()` Hibernation keeps idle connections open without duration charges; avoid `ws.accept()`, persistent timers or unresolved I/O/pending promises keeping the object active.
- Reference workload: **5 agents × 1 application inbound message/30 s × 86400s = 14,400 incoming messages/day ≈ 720 DO billable requests/day** from messages only. Connection establishment, MCP/DO RPC, rows read/written, application work duration and other app DO usage are additional. Protocol-level ping/pong can avoid processing application heartbeats.
- These are **shared account ceilings**; include IMA Durable Object usage. No evidence yet of actual 24–72h hibernation or total monthly/day consumption for this proposed service; the availability of a Free tier is not a proof the deployed design will remain within it.

### Provisional recommendation

WS+DO Hibernation is currently the **preferred candidate** because it avoids the Mesh-specific interactive device no-reenrollment blocker while preserving per-device identity and the desired simple Linux Agent installation. This is **not an approved transport ADR or release authorization**. Mesh+VPC remains a valid contender if an isolated same-user two-device re-enrollment experiment demonstrates the strict Q5=B guarantee, as well as secure WSL2 routing.

**No account-level provisioning, device enrolment, API mutation, WebSocket soak test or Free-usage measurement has been executed in this review.** The comparison is official-doc-supported research, not a deployed validation.

## Pending decisions for next grilling

1. **Transport acceptance:** confirm WS+DO Hibernation v2 as the selected *design* (still subject to gated offline/security/Free usage tests), or explicitly require Mesh proof before selection.
2. **Pairing/owner approval:** determine exact owner authentication for the v2 pairing approval surface (reuse independently authorized Portal/Bearer admin flow, or deploy a separate authenticated browser identity flow) and interactive vs headless UX.
3. **Release proof:** set an acceptance/test plan for two independent networks, Linux+WSL2, offline/unknown outcome/reinstall, explicit revoke, online session stop attempt, stolen-key reconnect denial and at least 24–72h DO idle quota evidence.
4. **Operation lifecycle:** settle implementation details for bounded wait/timeout, durable tiny device registry and revocation tombstones without unnecessary general-purpose queues.

## Primary sources (2026-10-14 consultation)

- https://developers.cloudflare.com/workers-vpc/examples/connect-to-cloudflare-mesh/
- https://developers.cloudflare.com/workers-vpc/configuration/vpc-networks/
- https://developers.cloudflare.com/mesh/platform/
- https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/device-registration/
- https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/deployment/device-enrollment/
- https://developers.cloudflare.com/cloudflare-one/tutorials/deploy-client-headless-linux/
- https://developers.cloudflare.com/api/resources/zero_trust/subresources/devices/subresources/registrations/methods/delete/
- https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- https://developers.cloudflare.com/durable-objects/platform/limits/
- https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/download/support-lifecycle/
