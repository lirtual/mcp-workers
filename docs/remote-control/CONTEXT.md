# Remote Control MCP — Domain Context

> Status (2026-10-13): architecture accepted (ADR-0011/0012/0013); real-client Bearer read-only path validated (T02), **restricted read-only** release accepted (T10 #12). Writes/Shell remain disabled in production. Shell requires separately tracked #14 and explicit authorization; lifecycle and historical-log limitations are detailed in T10.

## Language

**Remote Control MCP**:
A single-user, self-hosted MCP product that allows an authorized AI client to request controlled operations on a Linux host.
_Avoid_: **Remote Desktop MCP**, which implies remote graphical screen access and conflicts with the similarly named vendor product.

**Linux Host**:
A Linux machine or Linux runtime environment targeted for remote operations.
_Avoid_: Treating WSL2 as the only supported host.

**WSL2 Linux Environment**:
A possible deployment variant of the Linux Host, not a product or protocol requirement.

**Working Directory**:
The optional directory from which a development command runs; it is a convenience setting, **not** a filesystem access boundary. A remote operation is subject to the Linux Agent account's normal operating-system permissions.
_Avoid_: Treating the current directory or project root as a security sandbox.

**Remote Operation**:
A request from an authorized client to inspect or change files, run a development command, or interact with a managed process under the Linux Agent account's permissions; each operation has a defined authorization boundary and outcome.

**Managed Process**:
A development process started and tracked through Remote Control MCP under the Agent's Linux account; it may continue beyond the originating tool call.
_Avoid_: Assuming permission to manipulate every process on the Linux host.

**Managed Session**:
The locally identifiable lifecycle of a Managed Process with retrievable state, bounded output and explicit stop capability.
_Avoid_: Treating a remote HTTP request as the lifetime of the managed process.

**Curated Tool Surface**:
The reviewed set of client-visible development operations natively implemented by the Agent. Their familiar names are a product contract, not a pass-through to Desktop Commander.

**MCP Portal Caller**:
A remote MCP request source that supplies the Remote Control MCP-specific Bearer credential through the existing Portal integration. This token proves possession of the credential, not a separately logged-in end-user identity.
_Avoid_: Assuming that arbitrary direct remote MCP clients support static Bearer setup, or that a token shared by other MCP Workers is valid here.

**Portal Bearer Credential**:
A static, independently generated high-entropy secret recognized by only the Remote Control MCP ingress. It grants access to curated remote operations under the Agent's OS-user permissions.
_Avoid_: Confusing a static Bearer credential with OAuth authorization or sharing it with lower-privilege MCP Workers.

**Graphical Desktop Control**:
Remote viewing or manipulation of a desktop screen, mouse or keyboard. This is excluded from the first release.

**Execution Boundary**:
The operator's existing Linux login account and its effective filesystem/process privileges used by the Agent for local execution. No dedicated service account, container or project-root isolation is required in v1.
_Avoid_: Treating a directory filter, current working directory or command blacklist as a security sandbox.

**Unattended Remote Operation**:
A permitted remote operation that may proceed while the device owner is not locally available to confirm each action.
_Avoid_: Assuming unattended implies root privileges or arbitrary process ownership.

**Operation ID**:
A stable identity for one remote operation, reused when querying or reconciling that operation rather than creating a new execution intent.

**Operation Receipt**:
The authoritative minimal record of whether a state-changing operation was admitted and which execution state is known, allowing interrupted calls to be reconciled.

**Unknown Outcome**:
A state in which an operation may have reached execution but available evidence cannot establish its final effect.
_Avoid_: Relabeling an uncertain operation as failed or safe to retry.

## Settled product boundaries

1. The product name is **Remote Control MCP**; the prospective Worker identifier is `remote-control-mcp-worker`.
2. The system is **Linux-first**. WSL2 is a deployment variant and is not required for core execution.
3. This is a separate MCP application context, independent of the existing Database, IMA and Raindrop contexts.
4. First-release tool categories remain **file read/write, search, development Shell and managed processes**. There is no project directory allowlist; filesystem reach is defined by the Agent's Linux account (ADR-0011). Root-level administration and arbitrary unrelated process control remain out of scope.
5. **MCP Portal static Bearer ingress with a Remote Control-only secret value is accepted**; do not use OAuth for v1, and do not reuse the token value shared by other MCP apps. Actual Portal/ChatGPT header delivery must be proven before write/Shell activation (ADR-0012). Unauthenticated remote Shell is forbidden.
6. **Graphical desktop, mouse, keyboard and native Windows execution** are not first-release product capabilities.
7. **VPC-only private network connection** is a first-release constraint, without publicly publishing the device endpoint. See ADR-0004.
8. The **Execution Boundary is the operator's existing ordinary Linux login account**, used directly by the Agent. No dedicated service account, container or project-root path allowlist; see ADR-0011, which supersedes ADR-0005.
9. **Unattended Remote Operations** remain required for permitted development activities. With direct OS-account execution, their reachable files and secrets are broader than originally planned; see ADR-0006 as amended by ADR-0011.
10. State-changing operations must have stable **Operation IDs** and minimal local **Operation Receipts**. An **Unknown Outcome** cannot be blindly replayed. See ADR-0007.
11. The client sees a **Curated Tool Surface**, restricted to necessary file, search, development Shell and managed-process tool categories, **not** to a project-root path allowlist. See ADR-0008 and ADR-0011.
12. **Managed Sessions** may outlive the originating MCP request; support status, bounded output and explicit stop, without affecting unrelated host processes. See ADR-0009.
13. One Remote Control MCP Worker uses the existing Portal Bearer validation pattern rather than OAuth. ADR-0012 supersedes the OAuth decisions in ADR-0003 and ADR-0010.

## Unsettled boundaries — not approved yet

- The exact allowed tools and parameters; how destructive workspace writes, interactive process inputs and secret handling are authorized.
- Managed-session lifecycle details: stopping/canceling, output paging, quotas and behavior after device restart.
- Exact local receipt retention/storage, crash recovery, token revocation and cleanup rules.
- Actual ChatGPT/MCP Portal delivery of the separate static Bearer credential, token provisioning/rotation and denied-request acceptance; compatibility with arbitrary non-Portal MCP clients is not guaranteed.
- Actual permissions and secret exposure of the **confirmed existing normal Linux login account**, ingress compromise risk, limits (payload, output, time), supported tool shapes and rollout/monitoring policy.

Architecture and deployment implementation details belong in the research draft and ADRs, not in this vocabulary document.

## Future product goal — multi-device onboarding (discovery, 2026-10-14)

The owner wants to install Remote Control MCP support on additional owned devices with minimal manual setup, then control a selected installed device through the **same** Remote Control MCP experience. This is a **product goal**, not an approved change to the v1 architecture, transport or production configuration.

**Managed Device (candidate term)**:
A device deliberately connected to the owner's Remote Control MCP for remote operations. It is distinct from the AI client, the human owner, and an individual managed process.

**Device Onboarding (candidate term)**:
The owner-initiated process of installing and making an additional device available for remote operations, without requiring the owner to repeat the existing manual setup on every device.
_Avoid_: Equating easy installation with anonymous or automatically trusted remote access.

**Device Selection (candidate term)**:
The intent to direct a remote operation at a particular managed device rather than implicitly treating all devices as the same host.

**Device Enrollment**:
The act of admitting a device to the owner's private connectivity environment. Enrollment does not by itself permit Remote Control MCP operations.
_Avoid_: Treating an enrolled device as an approved remote Shell target.

**Device Pairing**:
The separate owner-approved act of granting one device an independently revocable Remote Control MCP identity.
_Avoid_: A single shared device credential or assuming all enrolled devices may execute operations.

**Device Identity**:
A stable identity for one paired installation; changing the device's display name or network address does not change this identity.
_Avoid_: Using a hostname, transient IP, or human-friendly device label as authorization identity.

**Device Revocation**:
The owner-authorized transition after which the device cannot be used for new Remote Control MCP operations and, where it was enrolled in Cloudflare networking, its Cloudflare access is also withdrawn. A network registration that can be automatically re-created is not considered durably revoked.
_Avoid_: Describing a hidden or partially removed device as fully revoked.

**Device Availability**:
The observed state indicating whether the paired device can currently be reached for remote operations. Availability is distinct from pairing approval, and going offline does not automatically revoke identity.

**Device Reconnection**:
The return of a previously approved but temporarily unavailable device to a reachable state. Reconnection is not an authorization event and does not authorize replay of past remote operations.

**Reinstallation**:
A new installation lifecycle that requires fresh owner-approved pairing and a new device identity, even on a previously used physical host.

**Revocation Cleanup**:
The follow-up process that withdraws the specific device's external network/enrollment permissions after MCP authorization is already denied. It can remain incomplete and must be visible to the owner.
_Avoid_: Treating a failed or retrying external cleanup as a completed full revocation.

**Pairing Code**:
A short-lived, single-use value displayed on the physical device during installation so the owner can identify a specific pending enrollment. It is never the device's long-lived control credential.
_Avoid_: Treating the pairing code alone as a durable permission to execute operations.

**Pairing Approval**:
The explicit owner decision to trust one identified pending device for Remote Control MCP operations, distinct from the Agent's installation and network connection.
_Avoid_: Assuming possession of a generic MCP Bearer automatically proves an in-person approval or that an AI tool call alone implies owner consent.

**Device Credential**:
The installation-specific identity material that permits a paired device to authenticate on later connections and that can be revoked independently from other devices and the Portal caller.
_Avoid_: A shared per-fleet device token or a device display name as proof of identity.

### Confirmed network requirement — 2026-10-14

The owner intends to connect managed devices located on **independent home, office and cloud-provider networks**, not only devices on one LAN. Adding a device must not depend on the device obtaining a public IP, a manually opened inbound port, or direct reachability from an existing single-site Tunnel.

This settles **network reachability scope only**. It does not choose Cloudflare Mesh versus an Agent-initiated WebSocket relay, approve replacing the existing VPC Service, or promise that device onboarding is already automated.

### Confirmed installation scope — grilling round 2 (2026-10-14)

- **Q1=A**: The installer is allowed to automate installation and initial configuration of required supporting device software (including Cloudflare One Client) so that the owner does not repeat manual infrastructure steps on every device. This **does not** mean unattended, unauthenticated enrollment or implicit permission to distribute organization-wide secrets.
- **Q2=A**: The **initial target is Linux and WSL2 Linux environments**; native Windows and macOS execution is deferred. This is the target for future installer work, not a claim that those installers already exist or an approval to modify the running host.
- A device located on a separate home, office or cloud-provider network must be able to participate without a public device IP or manual inbound port forwarding.
- See [ADR-0014](./adr/0014-linux-first-one-client-onboarding.md) for the installation trade-off. This ADR does **not** select Mesh over WebSocket + DO, change v1's transport, or approve automatic Cloudflare resource creation.

### Confirmed authentication, pairing, revocation and targeting — grilling round 3 (2026-10-14)

- **Q3=A**: A device with an interactive UI joins through Cloudflare login when Cloudflare networking is used; a headless Linux server uses a separately authorized automated enrollment. Installation alone does not approve remote command execution.
- **Q4=A**: Every device needs owner-approved initial pairing and an independently revocable device identity, retained for subsequent operations without the owner manually copying a shared token.
- **Q5=B**: The first multi-device release must offer **one authorized removal action** that automatically revokes both Remote Control MCP control and the specific device's Cloudflare network access when that transport is used. Partial or recoverable revocation must never be reported as complete.
- **Q6=A**: One MCP endpoint must support `list_devices`, and operations in multi-device mode must explicitly identify their intended stable `device_id`.
- See [ADR-0015](./adr/0015-per-device-pairing-and-revocation.md) for the security and product decision trade-offs. In particular, deleting a Cloudflare device registration without preventing automatic re-enrollment does not satisfy Q5=B. This round **does not select the transport or authorize rollout**.

### Confirmed offline recovery, reinstall and cleanup — grilling round 4 (2026-10-14)

- **Q7=A**: Agents should reconnect automatically; offline devices immediately become unavailable when the disconnected state is known. No new offline commands may be stored, queued or delivered after reconnect.
- **Q8=A**: A normal connection loss does not terminate already-running Agent-owned commands. Local operation receipts and session state remain authoritative and are queried on reconnect; no unknown mutation may be blindly retried.
- **Q9=A**: Reinstalling creates a fresh device identity requiring new explicit pairing. The previous identity is processed through the ordinary removal/revocation workflow; matching hostname or IP is not proof of identity.
- **Q10=A**: Removing a device first denies new MCP operations immediately. If Cloudflare cleanup fails, retry safely and expose incomplete revocation until all required permissions are withdrawn and re-enrollment is prevented.
- The behavior of *already-running jobs under explicit device revocation* is a separate unresolved decision; Q8 only resolves ordinary disconnection.
- See [ADR-0016](./adr/0016-device-lifecycle-and-recovery.md). None of these decisions changes today's single-device runtime.

### Historical transport assessment — before round 6 (superseded by ADR-0018)

- Cloudflare documents cross-network Mesh routing through one VPC Network binding (`cf1:network`).
- Cloudflare documents automatic device re-registration after deletion if the same user/service identity remains eligible, so per-interactive-device durable network removal without affecting other devices is **not yet demonstrated**. This is a blocker for accepting Mesh as-is under Q5=B.
- Agent-initiated WebSocket + hibernating Durable Objects can manage device revocation without Cloudflare One network enrollment, but Q3/Q5's intended Cloudflare permission semantics for this alternate transport must be clarified before choosing it.
- See [multi-device architecture evaluation](./MULTI-DEVICE-ARCHITECTURE-EVALUATION.md) for fact-backed trade-offs, gaps and the next proof gates.

### Confirmed revocation semantics, production coexistence and explicit removal — grilling round 5 (2026-10-14)

- **Q11=A**: Revoke **every permission actually issued** to an individual device. Mesh devices must have both MCP device authorization and their **own** Cloudflare One network enrollment permanently invalidated; WS + DO devices without Mesh enrollment must have their device-specific app credential invalidated, currently attached WebSocket closed, and reconnection/command denied. No fictional Cloudflare One registration must be created just to delete it.
- **Q12=A**: Keep the currently deployed single-device VPC Service + private Tunnel in production unchanged. Design and verify v2 separately and opt-in; cut over only after explicit acceptance and rollback-safe migration.
- **Q13=A**: Explicit removal immediately blocks all new operations; if the device is online, request best-effort termination of Agent-owned managed processes. If offline/untrusted, process termination is **not** guaranteed and must not be reported as confirmed. Under normal disconnection (Q8=A), processes may continue.
- **Q3 conditional on transport**: Interactive Cloudflare login/headless Service Auth apply to **Mesh/Cloudflare One enrollment**. If WS+DO is selected, these are not performed for device networking and a separate owner-approved pairing UX must be decided. Neither Cloudflare One authentication nor OAuth magically transfers to WS.
- [ADR-0017](./adr/0017-multi-device-revocation-semantics-and-transport-gates.md) records these accepted requirements and a **provisional WS + DO Hibernation preference, not a final transport decision**. Workers Free + DO Free budget and 24–72h hibernation verification are required before acceptance.

### Confirmed v2 transport and pairing experience — grilling round 6 (2026-10-15)

- **Q14=A**: Select Agent-initiated outbound **WebSocket + SQLite-backed Durable Objects WebSocket Hibernation API** as the **future multi-device v2 design**. It is selected for design, **not implemented or authorized for production**. Existing single-device VPC Service + private Tunnel v1 is untouched; do not reinterpret ADR-0004 as superseded for production.
- **Q15=A**: Reuse the existing Remote Control-only `MCP_ACCESS_TOKEN` and Portal Bearer middleware at the authenticated MCP-side **pairing-approval** boundary. The owner must explicitly approve one pending device. Bearer possession alone is **not equivalent to a proved logged-in human identity**, and the ChatGPT tool-permission UI is not assumed to supply approval.
- **Q16=A**: The installer displays a **short-lived one-time pairing code locally**. Owner enters the code into the MCP approval flow and explicitly confirms; after an atomic, one-use activation, Agent automatically saves an **independent, revocable device credential**. Do not distribute the Portal Bearer, admin Cloudflare key or shared static `REMOTE_CONTROL_DEVICE_TOKEN` to installed devices.
- This selected v2 architecture **does not create a Cloudflare One/Mesh enrollment**. Q3's interactive Cloudflare login applies only to the previously considered Mesh transport, not to v2. The owner approves v2 device pairing via the independently authenticated MCP entrypoint instead.
- Q7–Q13 continue to govern reconnection, identity, no blind replay, all actually granted permissions revoked, and best-effort Agent-owned session stop on explicit removal.
- [ADR-0018](./adr/0018-v2-websocket-do-transport-and-portal-pairing.md) is the accepted v2 architecture decision; [v2 pairing/security/hibernation acceptance plan](./V2-PAIRING-AND-HIBERNATION-ACCEPTANCE.md) is a **candidate protocol and required test matrix**, not a finished implementation.

### Remaining open design decisions and verification

- Determine how Portal-authenticated approval proves a real owner-initiated **specific** device confirmation with the actual ChatGPT client; an untrusted model making a tool call must not silently authorize an Agent.
- Approve pairing-code entropy, expiry, attempt limits, on-device proof-of-possession and persistent credential format/rotation; protect bootstrap from abuse without weakening MCP ingress auth.
- Agree on DO SQLite coordinator/hibernation event and storage contract, bounded pending RPC correlation, offline-detection policy, and best-effort stop outcome reporting.
- Validate Linux + WSL2 installation in separate networks, revocation of a stolen credential, no replay after disconnect, 24–72h 5-device idle Hibernation/Workers Free budget including shared IMA DO consumption, and v1 rollback safety.
- Future code/installer implementation, nonproduction Cloudflare resources, security testing, production rollout and v1 cutover require separately authorized steps.

Do not modify the accepted v1 ADRs solely on the basis of this product goal. Record a new architecture decision after the trade-offs above have been resolved.
