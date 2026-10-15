# Remote Control MCP — Domain Context

> v1 status: ADR-0011/0012/0013 accepted. T02/T10 established the historical read-only path; subsequent T11 #14 approved file writes and Shell as independently controlled capabilities. Current *live* enablement must be checked against Cloudflare configuration, not inferred from the earlier T10 snapshot. v2 multi-device is design-only and is not deployed.

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

## Future v2 multi-device context — chosen design, not deployed (2026-10-15)

**Product goal:** one Remote Control MCP explicitly controls multiple individually approved Linux/WSL2 Agent installations across independent home, office and cloud networks; native Windows/macOS remote execution is deferred. Each new device should be convenient to install without a public IP, firewall inbound rule or manual Cloudflare resource/credential management.

**Transport:** selected v2 is an Agent-initiated outbound TLS WebSocket to one owner-scoped SQLite-backed Durable Object using WebSocket Hibernation; **no Cloudflare One Client, Mesh, VPC Network, separate site Tunnel or per-device DO** is required. Earlier consideration of One Client was contingent on using the now-rejected Mesh transport. Existing v1's fixed VPC Service + private Tunnel and independent Portal token remain authoritative **for current production**, which is not migrated by this decision.

**Device Identity:** a server-issued opaque `device_id` uniquely identifies an approved installation, not its display label, hostname, IP or current socket.

**Pairing Code:** exactly 10 cryptographically random Base32 characters shown locally by a fresh Agent installation, single-use and expiring after 10 minutes. It identifies a pending pairing but is never a long-lived device credential.

**Device Pairing:** the Remote-Control-specific Portal Bearer-authenticated `pairing_lookup` shows one pending device and fingerprint; `pairing_prepare` returns a single-use 12-character Base32 challenge (five minutes) but cannot approve. The owner manually enters the original 10-character device code and 12-character challenge in the **new Agent's own local terminal/SSH**, and the Agent signs them with its locally stored private key. Only the matching one-use DO proof can issue `device_id`. Portal Bearer by itself is **not** human-presence proof; this separate terminal requirement assumes the model cannot operate that host or obtain its private key. This is an explicitly owner-approved refinement (2026-10-15) and still requires nonproduction client/host verification.

**Device Credential:** a per-installation private/public keypair generated locally (prefer standard Ed25519 after interoperability validation); the Agent retains the private key and proves possession via fresh signed server challenge. Reinstall means a new key, new `device_id`, new pairing.

**Device Selection:** one MCP lists known devices with `list_devices` and every v2 operation explicitly specifies a trusted `device_id`; never default silently to another device or accept a client-selected private IP/URL.

**Device Availability:** a currently approved Agent connection observed usable by the service. Known disconnects immediately become offline; silent partitions require a bounded measured detection delay. Reconnect is automatic, with **no offline command queue**.

**Operation Outcome:** existing local `operation_id` receipts remain authoritative for state-changing operations. During ordinary disconnection, running Agent-owned commands may continue; when outcome is uncertain, do not blindly replay.

**Device Revocation:** persistently deny the device key before all other actions, reject new commands/connections, close the socket, and request **best-effort** termination of online Agent-owned sessions. Offline/compromised local processes cannot be certified stopped. Re-pairing requires fresh deliberate owner approval. Because v2 never issues Cloudflare One device registration, there is no Cloudflare One permission to remove.

**Free and testing gate:** five simulated Agent connections for 72 continuous nonproduction hours, with demonstrated actual Hibernation/recovery, DO and Workers Free shared quota headroom, replay/steal/revoke tests, Linux+WSL2 network/lifecycle proof, and non-disruptive v1 migration. No test or production change is authorized by these design decisions.

**Canonical v2 design sources:** [ADR-0014 — v2 transport](./adr/0014-v2-multi-device-ws-do.md), [ADR-0015 — owner pairing/identity](./adr/0015-v2-pairing-and-identity.md), [v2 technical Spec](./V2-MULTI-DEVICE-SPEC.md). Grilling Q1–Q20 and competing-transport exploration remain retrievable in the [Draft PR #45 discussion](https://github.com/lirtual/mcp-workers/pull/45) and Git history, not as active implementation instructions.
