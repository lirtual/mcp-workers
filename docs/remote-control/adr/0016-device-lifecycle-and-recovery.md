# ADR-0016 — Multi-device offline recovery, identity reset and revocation reconciliation

Status: **accepted future-product requirements; implementation choices under design**. Date: 2026-10-14.
Decision input: grilling Q7=A, Q8=A, Q9=A, Q10=A.
Scope: future Remote Control MCP multi-device release; current production single-device v1 and ADR-0004/0012/0013 remain unchanged.

## Context

The owner plans one Remote Control MCP controlling separately paired Linux/WSL2 Agent installations in home, office and cloud networks. Devices can disconnect, sleep or restart; the Agent runs commands and tracks mutation receipts locally. The first multi-device release must offer automatic and device-scoped MCP + Cloudflare network revocation if the Cloudflare One/Mesh transport is selected (ADR-0015/Q5=B).

Disconnections must not create implicit new execution intent, and a failed Cloudflare administrative API request cannot cause a removed device to regain MCP permissions.

## Decisions

1. **Q7=A — Offline/reconnect**: The installed device automatically reconnects after a transient network outage or applicable service restart. Mark it unavailable when connectivity is known lost; reject *new* commands while unavailable, rather than buffering, scheduling or executing them on a later reconnection. A stale heartbeat is not evidence of online status. Exact heartbeat, detection window, retry backoff and max retry behavior are implementation details, not extra user-visible configuration.
2. **Q8=A — Running operations**: A connectivity break by itself does not terminate an already-started Agent-owned command or managed process. Local durable operation receipts and session ownership remain authoritative. A caller can query known operation state using the same `device_id` + `operation_id` once the device reconnects. Never blindly replay writes, process starts, or other mutations based on a timeout or unknown result. If the device or its receipt store is lost, represent the result as unknown; do not claim an operation was not executed.
3. **Q9=A — Reinstall creates new identity**: Reinstalling the Agent is a new installation requiring explicit pairing and a new opaque device identity and credential. A matching hostname, username, IP, hardware identifier, backup or display name never automatically inherits the former device's authorization. The old identity is invalidated via the normal dual-layer removal workflow; if its Cloudflare cleanup cannot complete, report incomplete revocation while continuing to deny MCP operations.
4. **Q10=A — Fail closed and reconcile removal**: On an owner-authorized removal, persist an MCP deny/tombstone *before* any Cloudflare operation or device notification, so online/offline/previously paired devices cannot receive new MCP requests. Persist narrowly scoped pending Cloudflare cleanup work; retry safely with bounded backoff and stable identifiers, explicitly classifying absent/deleted resources. Show `revocation_pending` / `cleanup_failed` instead of claiming complete removal until the targeted device has actually lost Cloudflare access **and re-enrollment is prevented**. Do not roll back the MCP deny when Cloudflare is unavailable. An elevated error may require owner intervention after bounded failures; never silently abandon an unresolved cleanup.
5. **Device scoping and safety**: Each operation targets a validated registered `device_id` from `list_devices`. Do not permit callers to substitute private URLs/IPs or infer authorization from Mesh reachability. Store only the minimal device lifecycle and operation references required; no project directory allowlist or device-wide admin capability is added here.
6. **Previously running commands on explicit revocation**: Q8 decides that ordinary **disconnection** does not stop a running process. It does **not** grant a remote guarantee of stopping processes upon explicit device revocation while the host is disconnected or compromised. Any cancellation policy and its achievable guarantees require separate validation; removal must always prevent *new* MCP dispatch first.
7. **WSL2 lifecycle**: The Windows host's Cloudflare One Client may be available while the WSL2 environment or Linux Agent is stopped. MCP availability must reflect Agent reachability, not only host Mesh status. Automatic resumption after a full host reboot/WSL2 shutdown is an explicit feasibility and operator-permission gate, not an assumed capability.

## Accepted clarification — Q11=A/Q12=A/Q13=A (2026-10-14)

See [ADR-0017](./0017-multi-device-revocation-semantics-and-transport-gates.md):
- **Q11=A** scopes automatic revocation to the permissions actually issued by the selected transport. Where no Cloudflare One/Mesh enrollment exists, there is no Cloudflare One registration to delete; the WS+DO device credential, attached socket and subsequent authorization must instead be revoked. Cloudflare clean-up/retry applies only when the device actually received a Cloudflare enrollment identity.
- **Q12=A** requires the current production v1 fixed VPC Service and private Tunnel to remain unchanged during optional v2 work.
- **Q13=A** resolves explicit revocation policy: deny new work first; if reachable, ask the Agent to stop its **owned managed sessions** on a best-effort basis, then report stop outcome and revoke its connection. Offline hosts can continue processes and must not be described as remotely terminated. This does not change Q8=A for an ordinary disconnection.

## Consequences and trade-offs

- **Positive:** avoids unattended delivery of stale Shell operations; preserves current local receipt/no-blind-replay safety; owner can revoke devices promptly even when Cloudflare's management API is down.
- **Cost:** requires durable small per-device authorization records/tombstones and cleanup state (even when no general-purpose job queue is introduced), robust restart reconciliation and a bounded retry mechanism. Reinstall produces a new identity rather than silent recovery of the old one.
- **Unresolved:** exact state/storage technology, heartbeat interval/limits, offline visibility latency, process policy on *revocation* (not disconnect), cleanup scheduling/expiry, delegated Cloudflare API permissions and user-facing retry/report interface.

## Required acceptance tests (not yet performed)

- Offline device is unavailable; no new operation is queued. Online again after restart; rejected offline commands never run.
- Kill connection after submission: status after reconnect matches local receipt; repeated `operation_id` cannot produce a second mutation.
- Reinstall with same visible name cannot reuse an old identity or session.
- Force Cloudflare API failure: MCP deny is immediate; cleanup remains pending, retries without touching other devices; UI never reports full success.
- For Mesh transport: after deleting/revoking a device, test whether *that one device* can automatically re-enroll with its original interactive user or headless credential. No auto-reenrollment and no collateral impact on other devices are required to satisfy Q5=B.
- In WSL2, Windows host connected but Linux Agent stopped must show unavailable, and service restart does not cause old commands to replay.

## Compatibility, safety and references

The existing single-device VPC Service/Tunnel implementation remains authoritative (ADR-0004, ADR-0012, ADR-0013). This ADR is a **decision record only**; it does not authorize changes to Worker, Agent, scripts, credentials, Cloudflare resources, CI or production.

Related: [ADR-0014](./0014-linux-first-one-client-onboarding.md), [ADR-0015](./0015-per-device-pairing-and-revocation.md), [ADR-0007](./0007-local-receipts-and-no-blind-replay.md).

Cloudflare evidence:
- https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/device-registration/
- https://developers.cloudflare.com/workers-vpc/examples/connect-to-cloudflare-mesh/
- https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/deployment/device-enrollment/
