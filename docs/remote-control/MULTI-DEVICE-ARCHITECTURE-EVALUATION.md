# Multi-device architecture evaluation — evidence and decision gate

Status: **discovery / proposed architecture, not accepted**. Evaluated: 2026-10-14.
Links: [Domain context](./CONTEXT.md), [ADR-0014](./adr/0014-linux-first-one-client-onboarding.md), [ADR-0015](./adr/0015-per-device-pairing-and-revocation.md), [ADR-0016](./adr/0016-device-lifecycle-and-recovery.md).
**This is a documentation-only comparison, not a Cloudflare account/prototype test.**

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

## Outstanding decisions for next grilling

1. **Q11 / authorization semantics:** Does Q5=B require per-device deletion of a Cloudflare One Mesh registration even for a non-Mesh transport, or only revocation of all permissions actually granted by the selected architecture? This changes whether WS/DO is eligible.
2. **Q12 / evidence threshold:** Will the owner accept an official-document-based Mesh disqualification absent a device-scale proof, or insist on isolated disposable end-to-end tests first? Current documentation does not validate permanent device-specific re-enrollment denial.
3. **Q13 / transport migration:** Continue single-device VPC in production while developing next generation as a separate opt-in path, or require an immediate in-place migration (not recommended)?
4. **Q14 / explicit revocation behavior:** On device removal, do already-running local jobs continue (as Q8 says for disconnect) or should an online Agent stop owned sessions on best-effort signal? Neither option can guarantee termination of offline commands.

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
