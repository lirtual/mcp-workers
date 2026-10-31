# Remote Control MCP — Domain Context

**Current state (verified 2026-10-28):** Remote Control is deployed through the existing Portal, per-device signed WSS and SQLite-backed Durable Object. Windows x64 and Ubuntu WSL2 are both online with the immutable **Agent v0.1.35**, permanently paired under their original device IDs. The ten existing Agent-owned browser MCP tools remain available; normal browser automation requires an approved device grant and no per-operation approval page. Browser Handoff [Spec #280](https://github.com/lirtual/mcp-workers/issues/280) was cancelled (`not_planned`), and its MCP/Agent controls and public `/browser-approve/*` entrypoint were retired. MCP-initiated `upgrade_agent` and `/upgrade-approve/*` were also retired in favor of verified, owner-interactive local one-click installers. Historical design and release status below is retained as context and must not be mistaken for current deployment instructions.

## GitHub-hosted Session scoped access (Spec #62, unpublished candidate)

The pending Workflow Session change adds D1 migration `0019_session_rca_duration.sql` to the **existing** `session_executions` record. The first signed physical Ready from reviewed `ubuntu`/`windows` Runner code freezes `durationMinutes` (1–300) via the same Ready CAS. A different replay cannot change it. Repository-managed RCA duration requires this signed job-environment snapshot plus the exact GitHub Job start, active physical status, cancellation fence, and approved immutable Plan; absent, invalid or untrusted evidence denies RCA but not SSH/RDP. Explicit Plans must agree with any supplied signed duration snapshot. Apply the existing migration before deploying the matching Workflow code; no independent database, device state store or authorization service. This is an unpublished candidate, not production acceptance.


Workflow MCP remains the sole authority for approved and still-running Windows/Ubuntu physical Session Attempts; this Worker owns device identity, signed WSS and operation receipts. The candidate implementation binds to the Workflow `SessionAuthorization` named WorkerEntrypoint through a one-way **private Service Binding**, never a public authorization URL. Before a signed WSS challenge/activation, device list eligibility or each new read/mutation, the existing Owner DO checks the exact Attempt, physical Run/Attempt, OS workflow and immutable deadline with a fresh Workflow decision. Missing Binding, RPC errors or mismatches deny **Session grants only**, without hiding permanently paired personal devices or changing SSH/RDP availability. Already admitted operation receipts remain independently factual after cancellation. Do not reuse this Session-specific permission for manual permanent or 24-hour pairing.

The candidate now also routes a **Session-only**, signed proof and GitHub OIDC enrollment payload through the existing `/agent/pair/start` endpoint into the Owner DO. An exact-current Workflow OIDC admission, signed physical Attempt nonce, transactional one-Attempt device map and a second post-write live check are required; ordinary manual pairing remains unchanged. Registration alone does not establish Agent online readiness. The candidate still lacks verified noninteractive Agent startup, Windows ACL and GitHub-hosted E2E; keep it Draft until all release-order boundaries are accepted.

**Spec #628 implementation branch (not deployed as of this source change):** RCA's
ten `browser_*` and three `computer_*` tools and their executable Worker/DO
and Agent routing are retired. The Worker exposes only file, search, Shell,
managed sessions and device lifecycle. Existing signed WSS, immutable
self-contained Node.js 24 releases, Windows Job Object, Linux pidfd,
installation, historical read-only GUI receipts, and Unknown/non-replay rules
remain. The independent Browser MCP #418 is not touched. Production
deployments, Agent release, existing device upgrades, and local GUI-only
Profile/Grant cleanup are separate authorization and acceptance stages.

## Historical browser runtime context (archived, not active source guidance)



- **Automation browser:** The existing native Windows Agent manages a visible, Agent-private Chrome/Edge `BrowserContext` and Profile, separate from the owner's everyday browser. One active automation session per device contains multiple explicitly selected tabs, including tabs opened manually. A tab has a stable ID within that session; focus, title, URL and array position must not silently select a different target.
- **On-demand shared use:** MCP browser operations are bounded and serialized within the Agent; a person may also directly interact with the same window. There is no artificial Human/Agent handoff state, exclusive human-input lock, browser-specific session timeout, polling heartbeat, independent server or new business orchestrator. Reuse the session until explicit close, browser/Agent termination or revocation; normal Remote Control WSS lifecycle/authentication still applies.
- **Effects and receipts:** Mutating browser operations bind to the exact authorized device, tab and operation; use current snapshot/element information and the existing durable `operation_id` receipt path. Querying an original operation ID reconciles the same intent; an indeterminate external effect must not be blindly replayed.
- **Owner approval:** The owner approves the device **once** through one-code MCP pairing; browser effects require a valid device grant, authenticated Portal call, and signed Agent session, not a second Cloudflare Access webpage. No temporary-to-permanent grant upgrade exists: a new permanent grant requires an explicit new pairing with a new identity. This means compromise of MCP credentials/client can have greater effects; keep strict Agent/tool boundaries.
- **Accepted network limitation:** On a personally controlled Windows device, the owner accepted residual exposure from public pages, redirects, DNS changes and browser subresources to localhost/LAN; these protections have **not** established SSRF or private-network egress isolation and must never be represented as such. This acceptance is not permission to administer internal networks or claim private-network egress isolation.
- **Acceptance evidence:** The 2026-10-23 production Windows test completed browser navigation, fill, keypress, click and close directly through the signed paired-device session without a webpage approval; all operation receipts were verified. Full system-restart recovery and measurable idle Cloudflare resource use remain distinct operational observations; neither is implied by this Spec acceptance.

## Language

**Remote Control MCP**:
A single-user, self-hosted MCP product that allows an authorized AI client to request controlled operations on a Linux host.
_Avoid_: **Remote Desktop MCP**, which implies remote graphical screen access and conflicts with the similarly named vendor product.

**Linux Host**:
A Linux machine or Linux runtime environment targeted for remote operations.
_Avoid_: Treating WSL2 as the only supported host.

**Standalone Agent Installation**:
An Agent installation initiated with **one terminal command** on a supported **Linux x86_64 or ARM64 host, including WSL2**, without obtaining development source code or manually installing build tools, a language runtime or workspace dependencies. The product distributes a ready-to-run Agent package rather than making the target host build its own Agent.
_Avoid_: Calling a source checkout or a prerequisite-heavy build script a one-command install; assuming native Windows or macOS support.

**Agent Distribution**:
A versioned, ready-to-run package available to the owner for installing the Linux Agent independently of the source repository, containing what the Agent needs to operate on its supported platform.
_Avoid_: Treating the public availability of installation bytes as an authorization to pair or remotely control a host.

**Verified Agent Release**:
An owner-selected and integrity-checked immutable version of the Agent's distribution, distinct from both the local device identity and the authority to pair that identity.
_Avoid_: Treating a successful download or file hash match as independent proof that arbitrary installer code is trustworthy.

**Owner-Initiated Agent Upgrade**:
An explicit user action to replace installed Agent program files with another reviewed version while preserving the same approved device identity and prior operation history. Work actively owned by the Agent must be completed or explicitly stopped before upgrading. A failed upgrade can revert the program without implying that already changed data has been rolled back.
_Avoid_: Treating an upgrade as a new device enrollment, an extension of temporary authorization, or permission to discard uncertain work.

**Local Agent Uninstall**:
Removal of this Agent's installed program and managed startup, not an automatic removal of its cloud-side permission. Identity and local operation history are retained by default unless the owner separately confirms data deletion.
_Avoid_: Equating removal of local software with confirmed remote revocation.

**Interrupted Installation Recovery**:
Safely resuming the same intended Agent installation after an interrupted download, local setup or device confirmation without silently replacing a trusted device identity, duplicating authorization or erasing local receipts.
_Avoid_: Treating an expired or revoked pairing as permission for automatic re-enrollment.

**Permanent Agent Mode**:
An owner-chosen enrollment intended for the host's ongoing operation as a managed background service, with no temporary pairing expiry.
_Avoid_: Equating a background service with an always-online WSL2 host.

**Temporary Agent Mode**:
An owner-chosen foreground debugging enrollment, valid for no more than 24 hours from successful approval and without an automatic background service. Leaving the foreground session does not imply that remote permission has been revoked early.
_Avoid_: Assuming local process exit, disconnection or uninstall terminates server-side authorization.

**Agent CLI Pairing**:
The local terminal onboarding experience first **asks the owner to select a permanent or 24-hour temporary device** and shows one 10-character device pairing code. The owner enters it into authenticated MCP, performs separate explicit `pairing_approve` for the reviewed pending key/mode, then the Agent automatically proves its private key and obtains the approved device ID. No second local challenge. Portal Bearer/MCP action is not independent cryptographic proof of a human (owner-approved trade-off 2026-10-18).
_Avoid_: Treating the Agent's one-line installer as an owner authorization credential, or silently choosing a device lifetime without presenting it.

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

**Local Receipt Store**:
The Linux Agent's authoritative collection of Operation Receipts used to reconcile outcomes and suppress unintended repetition of state-changing requests across disconnections and restarts.
_Avoid_: Treating remote Worker transport acknowledgements, process logs, or a ChatGPT conversation as substitutes for a durable receipt.

**Receipt Retention Window**:
The normal period during which a previously admitted Operation ID remains available for outcome reconciliation and deduplication. An operation whose result is unknown remains protected beyond the normal window until explicitly reconciled.
_Avoid_: Treating storage cleanup or elapsed time as proof that a previous operation had no effect.

**Unresolved Operation Marker**:
The minimal retained identity and non-replay protection for an operation whose effect is still unknown after the normal receipt retention window. Only a deliberate, authenticated owner-led reconciliation can resolve that uncertainty.
_Avoid_: Discarding an unresolved identity just because it is old, or treating manual acknowledgement as automatic permission to replay the same operation.

**Bounded Development Command**:
A managed execution launched for temporary development work that must have a finite lifetime and an owner-scoped stop path.
_Avoid_: Treating a temporary development command as the preferred mechanism for keeping a permanent service running.

**Emergency Session Stop**:
An explicitly authorized request to stop only a Managed Process that the Agent can still prove it owns, even when operation-result persistence is unavailable. The stop may have an Unknown Outcome if durable acknowledgement cannot be recorded.
_Avoid_: General-purpose host process killing, unauthenticated overrides, or claiming a stop was durably recorded when it was not.

**Receipt Migration**:
The controlled transfer of existing authoritative Operation Receipts to a replacement local store without discarding unresolved Operation IDs or weakening outcome reconciliation.
_Avoid_: Treating a successful new-store startup as sufficient evidence that historical operation identities were preserved.


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
14. v1 and v2 Remote Control use the same Agent-side implementation for local Operation Receipts and Managed Sessions; differences in ingress and device routing do not create two local execution engines (2026-10-16 first-round decision; see ADR-0016).
15. Ordinary development commands have a finite execution lifetime, while durable/background services are managed outside the temporary command session contract (2026-10-16 first-round decision; see ADR-0016).
16. A local receipt-store migration must preserve all existing operation identities and outcomes before allowing new state-changing operations; failed verification cannot silently reset the store (2026-10-16 second-round decision; ADR-0016).
17. A Bounded Development Command stops after at most 60 minutes through the Agent's existing owner-scoped termination path: graceful stop first, bounded forced stop if necessary (second-round decision; ADR-0016).
18. Failure of local receipt persistence cannot grant permission for new writes or Shell commands; the already-authorized Emergency Session Stop remains available only for provably Agent-owned sessions and must report uncertain outcomes honestly (second-round decision; ADR-0016).
19. Unresolved operations retain a minimal non-replay marker beyond the normal 30-day retention window until explicit owner-led reconciliation. Elapsed time alone does not make an unknown operation safe to repeat (third-round decision; ADR-0016).
20. Normal terminal receipts expire under their retention policy. Storage housekeeping cannot evict still-protected receipts to meet an arbitrary count quota; when durable writes fail, new state-changing operations fail closed while the narrow Emergency Session Stop remains available (third-round decision; ADR-0016).
21. JSON-to-local-store migration is one-way. Returning to an older Agent is a deliberate operator-led restore/reconciliation activity, not an automatic dual-write or silent fallback (third-round decision; ADR-0016).

## Unsettled boundaries — not approved yet

- The exact allowed tools and parameters; how destructive workspace writes, interactive process inputs and secret handling are authorized.
- Managed-session lifecycle details: stopping/canceling, output paging, quotas and behavior after device restart.
- The v1 Agent receipt/timeout architecture and production migration were completed under Spec #60; device-token revocation and v2 human-confirmation, transport and quota acceptance remain separately controlled.
- Actual ChatGPT/MCP Portal delivery of the separate static Bearer credential, token provisioning/rotation and denied-request acceptance; compatibility with arbitrary non-Portal MCP clients is not guaranteed.
- Actual permissions and secret exposure of the **confirmed existing normal Linux login account**, ingress compromise risk, limits (payload, output, time), supported tool shapes and rollout/monitoring policy.

Architecture and deployment implementation details belong in the research draft and ADRs, not in this vocabulary document.

## v2 multi-device context — accepted design, implemented in isolated Preview

**Product goal:** one Remote Control MCP explicitly controls multiple individually approved Linux/WSL2 Agent installations across independent home, office and cloud networks; native Windows/macOS remote execution is deferred. Each new device should be convenient to install without a public IP, firewall inbound rule or manual Cloudflare resource/credential management.

**Transport:** selected v2 is an Agent-initiated outbound TLS WebSocket to one owner-scoped SQLite-backed Durable Object using WebSocket Hibernation; **no Cloudflare One Client, Mesh, VPC Network, separate site Tunnel or per-device DO** is required. Earlier consideration of One Client was contingent on using the now-rejected Mesh transport. Existing v1's fixed VPC Service + private Tunnel and independent Portal token remain authoritative **for current production**, which is not migrated by this decision.

**Device Identity:** a server-issued opaque `device_id` uniquely identifies an approved installation, not its display label, hostname, IP or current socket.

**Temporary Debug Device:** a separately and explicitly approved device identity for short-term debugging whose **authorization ends 24 hours after successful pairing approval**. Its deadline is fixed and unaffected by reconnect, Agent exit, network loss or activity; expiry denies new work even if a previously established connection remains open. Unlike a permanent device it cannot reconnect after the deadline. Earlier exit-coupled behavior was replaced by the owner's simpler 24-hour decision (2026-10-17; ADR-0018).

**Temporary Pairing:** the owner-approved one-code MCP pairing grants a **nonrenewable 24-hour temporary device authorization**. The 10-character pending code lasts ten minutes and one use; explicit authenticated `pairing_approve` binds the reviewed key and grant type, followed by Agent's automatic signed key proof. The 24-hour timer begins only at server approval and never extends on reconnect. This **supersedes** 2026-10-17's independent two-code decision (ADR-0018; updated 2026-10-18).

**Pairing Code:** exactly 10 cryptographically random Base32 characters shown locally by a fresh Agent installation, single-use and expiring after 10 minutes. It identifies a pending pairing but is never a long-lived device credential.

**Device Pairing:** the new Agent shows one **10-character, ten-minute, one-use local code**. Remote-Control-only Portal Bearer authenticated `pairing_lookup` **reads** the immutable pending device name, fingerprint and grant type; only a separate explicit `pairing_approve({pairing_id,expected_fingerprint,expected_grant_type})` atomically authorizes exactly that pending key. The Agent automatically proves the registered Ed25519 private key via a replay-safe signed claim and obtains its approved ID; each WSS session separately signs a fresh internal server nonce. **No manually copied 12-character challenge.** Portal Bearer verifies credential possession, not independent human presence. Compromised or prompt-injected authenticated MCP clients can approve their own pending device; the owner accepted that single-user risk on 2026-10-18. Existing #47/#50 two-code validation is historical and does not certify this current single-code protocol; distinct #97 acceptance is now completed.

**Device Credential:** a per-installation private/public keypair generated locally (prefer standard Ed25519 after interoperability validation); the Agent retains the private key and proves possession via fresh signed server challenge. Reinstall means a new key, new `device_id`, new pairing.

**Device Selection:** one MCP lists known devices with `list_devices` and every v2 operation explicitly specifies a trusted `device_id`; never default silently to another device or accept a client-selected private IP/URL.

**Device Availability:** a currently approved Agent connection observed usable by the service. Known disconnects immediately become offline; silent partitions require a bounded measured detection delay. Reconnect is automatic, with **no offline command queue**.

**Operation Outcome:** existing local `operation_id` receipts remain authoritative for state-changing operations. During ordinary disconnection, running Agent-owned commands may continue; when outcome is uncertain, do not blindly replay.

**Device Removal (formerly Device Revocation):** end an approved device identity's authorization. After removal, its former device ID is no longer a valid target or reconnect identity, and the device disappears from ordinary device listings. Disconnecting its live connection and stopping any owned work are separate best-effort effects; operations already admitted may remain uncertain. Removal does not permanently forbid a previously used public key from making a *new pending* request; a fresh grant still requires explicit authenticated owner-MCP approval and matching device private-key proof. There is no permanent removed-device history or blacklist (2026-10-17 owner decision; ADR-0017).

**Free and testing gate:** the owner-approved release gate is **one isolated Agent over 48 real nonproduction hours**, observing actual DO Hibernation/wake and account-level Workers/DO Free quota use alongside existing account resources, with previously completed pairing/revocation and v1 isolation evidence checked separately (Issue #57). The older five-device/72-hour plan is historical, not a current release requirement. No test or production change is authorized by design alone.

**Canonical v2 design sources:** [ADR-0014 — v2 transport](./adr/0014-v2-multi-device-ws-do.md), [ADR-0015 — owner pairing/identity](./adr/0015-v2-pairing-and-identity.md), [ADR-0017 — device removal/identity lifecycle](./adr/0017-v2-device-revocation-without-tombstones.md), [ADR-0018 — temporary pairing/24-hour grant](./adr/0018-v2-temporary-agent-pairing-lifecycle.md), [ADR-0019 — standalone Linux Agent distribution](./adr/0019-standalone-linux-agent-distribution.md), [v2 technical Spec](./V2-MULTI-DEVICE-SPEC.md). Grilling Q1–Q20 and competing-transport exploration remain retrievable in the [Draft PR #45 discussion](https://github.com/lirtual/mcp-workers/pull/45) and Git history, not as active implementation instructions.
