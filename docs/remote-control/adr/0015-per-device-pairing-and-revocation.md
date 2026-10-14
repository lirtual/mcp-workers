# ADR-0015 — Per-device pairing, targeting, and dual-layer revocation

Status: **accepted product and security requirements for future multi-device v1; mechanisms under design**. Date: 2026-10-14.
Decision inputs: grilling Q3=A, Q4=A, Q5=B, Q6=A.
Scope: future multi-device design only; existing production v1 and ADR-0004/0012/0013 remain unchanged.

## Context

Remote Control MCP currently authorizes one MCP Portal caller using a Remote-Control-only Bearer and then calls a single Linux Agent with a manually provisioned `REMOTE_CONTROL_DEVICE_TOKEN`. The owner now wants additional Linux/WSL2 devices across home, office, and cloud networks, preferably via automated installation while retaining a single MCP endpoint. An Agent can execute file writes and development Shell with its Linux account's permissions; enrollment into a private network alone does not grant permission to run commands.

Cloudflare Mesh + one VPC Network Binding and Agent-initiated WebSocket + Durable Objects remain candidate transports. These decisions do not yet choose one.

## Accepted decisions

1. **Q3=A — Network enrollment by device context**: An interactive device uses a Cloudflare identity login when the Cloudflare One Client/Mesh transport is chosen; a headless Linux server uses an explicitly authorized automated enrollment flow. Neither automatic installation nor an unattended service token silently grants Remote Control MCP execution access. No administrator Cloudflare token or common reusable enrollment secret may be baked into a public installer. Service Auth devices have different identity-based policy semantics than interactive login devices.
2. **Q4=A — Distinct Agent pairing**: After the network step, each Remote Control Agent must separately pair with the owner and persist its **own independently revocable device credential** automatically. Do not reuse the single-device `REMOTE_CONTROL_DEVICE_TOKEN` value across devices or require manual per-device copying. A device is not trusted merely because it is on Mesh. Pairing approval UX, key type, lifetime, secure exchange and storage are **unresolved implementation details**; no accepted choice yet of QR code, browser approval, one-time code, device-issued key or a token service.
3. **Q5=B — Automatic dual-layer removal in the first multi-device release**: The owner expects **one authorized removal action** to deny further MCP control and remove that device's Cloudflare network access **when Cloudflare Mesh/One Client is the transport**. This cannot be deferred to a later release. Remote-control device authorization must be denied first (fail closed); then the narrowly identified Cloudflare registration(s), relevant enrollment credentials/permissions, and discoverability must be withdrawn through authorized APIs. Failures or uncertainty must remain visible as incomplete cleanup, not a false success message. Do not remove unrelated registrations, shared user access, or shared network connectivity. If the architecture cannot make the revocation durable and device-scoped without affecting other devices, **the first-release acceptance gate is blocked**: revisit the identity/enrollment design before approving implementation.
4. **Q6=A — Single MCP, explicit target**: One Remote Control MCP endpoint exposes `list_devices` and identifies each owner-approved device by an opaque stable `device_id`. Multi-device remote operations require explicitly specifying/validating `device_id`; device names are labels, not authenticators or routing targets. Reject unknown, revoked, offline, or otherwise unauthorized targets; never treat client-provided IP/hostname/URL as the destination. Preserve single-device behavior only if backward compatibility can be shown without ambiguous target selection.
5. All sensitive operations retain existing server-side tool/argument validation, stable mutation `operation_id`, Agent-held receipts, and no blind replay on unknown outcomes. Device revocation must prevent **new** execution even if the device remains locally running or later reconnects. Exact cancellation guarantees for already-running processes are still open.

## Cloudflare API facts and release-blocking caveat

- Cloudflare One device **registration** is not equivalent to a permanent device ban: one physical device can hold multiple registrations, and a registration or device deleted/revoked while its user or service token can still authenticate may **automatically re-register**. Therefore a successful API delete alone does **not** satisfy Q5=B.
- Cloudflare recommends **deleting registrations** over deprecated revocation APIs because deletion releases virtual IPs. The API for deleting a particular registration requires `Zero Trust Write`; physical-device deletion also exists. An authorized cleanup process must confirm ownership and mapping between the MCP `device_id` and the Cloudflare physical-device/registration IDs before deleting anything.
- For unattended enrollment, Cloudflare can authorize a specified Access Service Token, and service tokens can be created/deleted via API using `Access: Service Tokens Write`. One **per-device**, independently revocable enrollment authorization may help fulfill Q5=B, but the API, enrollment policy behavior, Cloudflare limits, secret handling and post-deletion re-enrollment must be tested. A single shared Service Token across headless devices undermines per-device revocation.
- For **interactive** Cloudflare identity login, deletion of a registration does not automatically block that same human user from re-enrolling. A reliable device-specific no-re-enrollment control **without disabling the owner's other devices** has not yet been proved. This is a blocking proof requirement, **not** an assumption that existing Cloudflare APIs solve it.
- Never place a broad Cloudflare administrative API token in an install command, Agent, device-side config, MCP request argument, response or diagnostic log. Consider separating narrowly authorized Cloudflare provisioning/removal actions from ordinary MCP operations. Exact permission scoping and API execution boundary are still undecided.

Relevant primary documentation:
- [Device registrations and re-registration behavior](https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/device-registration/)
- [Device registration deletion API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/devices/subresources/registrations/methods/delete/)
- [Physical device deletion API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/devices/)
- [Headless Linux service-token enrollment](https://developers.cloudflare.com/cloudflare-one/tutorials/deploy-client-headless-linux/)
- [Service token deletion API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/service_tokens/methods/delete/)

## Consequences and trade-offs

**Positive:** one MCP surface, clear per-device authorization boundaries, no user-managed `REMOTE_CONTROL_DEVICE_TOKEN` on each host, targeted deletion, and an explicit security guarantee for the first multi-device release.

**Cost/risk:** enrollment and MCP pairing have separate lifecycles; the system must durably map trusted device IDs to specific Cloudflare identities/registrations without coupling identity to an ephemeral Mesh IP. Q5=B imposes an administrative control-plane integration and raises credential-scope, partial-failure and re-enrollment complexity. These are deliberate costs of first-release automatic dual-layer revocation rather than hidden future work.

## Clarification from accepted grilling Q11=A and Q13=A (2026-10-14)

[ADR-0017](./0017-multi-device-revocation-semantics-and-transport-gates.md) clarifies Q5=B without weakening it: revoke **all privileges actually granted** by the selected device transport. For Mesh, this includes permanent removal of the target's Cloudflare One enrollment and blocking re-registration; for WS+DO with no Cloudflare One device registration, it includes persistently denying that Agent's credential, closing its connected WebSocket, and refusing future upgrade/dispatch. Do not install Cloudflare One merely to satisfy a deletion ceremony.

An **explicit removal** also requires immediate server-side denial and, for an online Agent, a best-effort authenticated stop of **Agent-owned** managed sessions. An offline or compromised Agent cannot be guaranteed to stop local jobs. This supersedes the earlier unresolved language below on the policy, but exact implementation and tested guarantees remain open.

## Next grilling frontier (unsettled)

- **Q7** — Offline and reconnect: startup/host reboot, WSL2 host lifecycle, failure bounds, expiry and device-online presentation.
- **Q8** — Already-running mutations/sessions during disconnect/revoke and reconciliation after unknown outcomes.
- **Q9** — Device lifecycle: rename, reinstall, identity replacement, lost/stolen hardware, uninstall and loss of Cloudflare administration access.
- **Q10** — Architectural proof and fallback: verify Mesh networking and genuinely device-scoped no-re-enrollment versus WS+DO with application-owned device identities, then select a transport and update superseded ADRs if applicable.

## Safety boundary

This ADR records the owner's accepted requirements, **not a completed protocol or deployed revocation mechanism**. Do not modify Worker/Agent, secrets, Cloudflare resources, portal connections, CI or production configuration as part of this documentation change.
