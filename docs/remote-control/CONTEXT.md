# Remote Control MCP — Domain Context

**Current implementation status (2026-10-18; the original design-time snapshots below are historical):** Single-code device pairing is implemented on Draft PR #79 and has genuine nonproduction x64 acceptance ([#97](https://github.com/lirtual/mcp-workers/issues/97) Closed), with public immutable Agent v0.1.8 TEST assets and the existing Preview Worker `/install.sh`. This does **not** authorize a merge or production change. Native external ARM64 owner onboarding (#74/#82), true online 24-hour expiry/Hibernation (#72/#75) and continuous 48-hour final gate (#57) remain open. v1 production is independent.

> Status (updated 2026-10-16): v1 Agent reliability source merged in [PR #66](https://github.com/lirtual/mcp-workers/pull/66) and [PR #67](https://github.com/lirtual/mcp-workers/pull/67), and v1 Linux Agent **was separately upgraded and verified** to Node 24 + SQLite under [Spec #60](https://github.com/lirtual/mcp-workers/issues/60) / [#65](https://github.com/lirtual/mcp-workers/issues/65). Original JSON and historical backup were preserved for intentional manual rollback; SQLite is now authoritative. v2 multi-device WSS/DO remains an independent **preview / Draft PR #58** and is not a v1 production replacement. Independent human terminal confirmation was separately evidenced on the isolated Preview device; the current single-device **48-hour** Hibernation/quota gate in Issue #57 remains unverified for production. The older five-device/72-hour requirement is historical and no longer this rollout's gate.

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

**Browser Automation**:
Device-scoped inspection and interaction with web pages and browser tabs through an authorized remote browser session; it does not imply control of the rest of the graphical desktop.
_Avoid_: Remote desktop control, arbitrary OS mouse/keyboard control.

**Automation Browser Session**:
An identifiable browser session for a remote automation workflow, reusable across interactions but not indefinitely active; a persistent automation profile can have only one active session at a time.
_Avoid_: Equating it to the Agent's Shell Managed Session, or treating it as implicit permission to inspect the owner's personal browser profile.

**Automation Browser Profile**:
A dedicated owner-controlled browser identity whose sign-in state may be retained locally across automation sessions, separate from the owner's everyday browser profile.
_Avoid_: Treating the owner's default Chrome/Edge profile as an automation profile.

**Automation Profile Clearing**:
An owner-requested removal of the retained local automation browser identity and its browser data, distinct from simply closing the browser session.
_Avoid_: Implicit clearing on logout, disconnect, browser-session close or device revocation.

**Personal Browser Session**:
An existing owner-used browser session whose tabs or signed-in state may be accessed only within explicitly authorized scope.
_Avoid_: Assuming that device pairing grants blanket access to every personal browser tab or profile.

**Browser Target**:
A specifically selected authorized device and browser session, narrowed to a tab where the operation requires one.
_Avoid_: An implicit default device or an unspecified global browser.

**Browser Tab ID**:
The stable identity of a managed browser tab within one device and Automation Browser Session, retained across navigation and invalidated when that tab closes.
_Avoid_: A tab's list position, page URL or title as a substitute for identity.

**High-Impact Browser Action**:
A proposed browser interaction that would commit a consequential external effect such as a purchase, sent communication, data deletion or permission change.
_Avoid_: Treating ordinary form preparation as already committed, or considering page text or device pairing to be owner approval.

**Browser Action Confirmation**:
The owner's explicit, single-use approval for a particular High-Impact Browser Action, bound to the intended device, browser session, tab and consequential action target.
_Avoid_: Assuming that a previous general workflow approval, a changed execution target, the browser's logged-in state or an untrusted webpage is confirmation.

**Proposed Browser Action**:
A specific consequential browser action presented for the owner's review before it is authorized to execute.
_Avoid_: Confusing a proposal with permission to execute, or treating the assistant's memory of approval as a verified confirmation.

**Browser Element Target**:
An unambiguous identifiable page element in the specifically selected browser tab, resolved using its meaningful semantic identity where possible.
_Avoid_: Guessing which duplicate control to click or treating a stale page position as a reliable identity.

**Visual Browser Target**:
A specific visible control or region in the selected browser tab identified from current visual evidence when meaningful semantic identification is insufficient.
_Avoid_: Treating a stale screenshot coordinate as a durable element identity or using it to control arbitrary desktop applications.

**Browser Page Observation**:
A bounded, task-relevant account of a selected page's semantic content or explicitly requested visual appearance, distinct from authorization or a guarantee that private data is absent.
_Avoid_: Treating an untrusted webpage as instructions or assuming a screenshot cannot reveal sensitive information.

**Browser Local Transfer**:
An upload or download initiated through an automation browser where the source or destination file stays on the Agent's device.
_Avoid_: Assuming browser file contents must pass through the remote MCP transport.

**Managed Browser Download**:
A website-originated file saved to the Agent's designated local browser download area for later owner-directed access using existing file capabilities.
_Avoid_: Equating a download with an MCP file attachment or assuming it may be deleted while needed for unresolved work.

**Managed Download Retention**:
The normal period before an unreferenced file in the Agent-managed browser download area becomes eligible for cleanup, distinct from Browser Profile data or the owner's other files.
_Avoid_: Erasing a download still referenced by active work or an unresolved operation.

**Browser Action Receipt**:
An Agent-local record of the known execution outcome of a potentially effectful browser operation, independently of whether the remote website completed the intended business transaction.
_Avoid_: Equating a click result with a confirmed purchase, submission or remote service commit.

**Browser Tool Result**:
The compact, structured response for an operation on an identified device/browser session and, when relevant, tab, distinguishing known execution status, error identity, bounded output and associated Operation ID for an effectful operation.
_Avoid_: Arbitrary Playwright internals, unbounded page dumps, or assuming a browser tool result confirms a remote business outcome.

**Website Effect Evidence**:
A separately observed, read-only indication that a website may have committed the intended operation, distinct from the Agent's execution receipt.
_Avoid_: Treating a successful click, a timeout or an unverified page change as conclusive proof of a website transaction.

**Browser Capability Gate**:
The distinction between browser actions allowed for the selected device/platform now and actions disabled pending trustworthy owner authorization or acceptance evidence.
_Avoid_: Inferring that a tool's planned interface makes all its potentially high-impact actions safe to execute.

**Conservatively Classified Browser Action**:
A proposed browser operation known to meet the limited low-impact execution boundary without relying on untrusted webpage claims; uncertain consequential effects do not qualify.
_Avoid_: Declaring an arbitrary click, fill, key press, URL or model-assessed button harmless solely because its visible label appears innocuous.

**Verified Browser Approval**:
An owner confirmation whose applicability to the exact one-use consequential operation is reliably established at the Agent execution boundary through the supported client and MCP path.
_Avoid_: Equating a chat response or possession of the MCP credential alone with end-to-end verified owner authorization.

**Browser Recovery Conflict**:
A state in which the browser's ownership, retained Profile availability or effectful operation outcome is insufficiently known to resume safely.
_Avoid_: Treating an uncertain lock, crash or lost response as evidence that restarting or repeating work is safe.

**Platform Browser Acceptance**:
Evidence that a named supported operating-system/runtime target actually satisfies the browser capability's agreed behavior and safety boundaries.
_Avoid_: Treating Linux acceptance as proof of native Windows readiness, or repeating unchanged evidence without a material reason.

**Browser Platform Release Gate**:
The readiness decision for one named platform based on applicable real browser behavior, authority-denial, interruption/recovery and upgrade/rollback acceptance evidence.
_Avoid_: Treating a design agreement as deployment authorization, or making an already-tested target repeat unrelated unchanged evidence because a different platform is not ready.

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


## Conservative effects, verified approval and platform release — accepted tenth round (2026-10-20)

[ADR-0030](./adr/0030-browser-conservative-gating-consent-evidence-acceptance.md) confirms four design directions: only Conservatively Classified Browser Actions can be enabled without consequential-action approval, and unknown impact fails closed; a Verified Browser Approval for a one-use high-impact action must be demonstrated through a real ChatGPT/MCP/Worker/Agent end-to-end acceptance path before enabling that capability; browser effects reuse existing Agent-local Operation IDs and Receipts, preserving Unknown Outcome without blind replay or a second website ledger; and each platform's Browser Platform Release Gate depends on relevant real-device launch, interaction, file, recovery, authorization and upgrade/rollback evidence, reusing unchanged tests where valid.

The exact safe low-impact subset, supported human-confirmation evidence channel, typed receipt states and platform cases remain unsettled. These accepted designs are **not** claims that proof, implementation, or rollout exists.

## Browser results, outcome evidence, retention and gating — accepted ninth round (2026-10-20)

[ADR-0029](./adr/0029-browser-results-outcomes-downloads-gated-release.md) records four decisions: use a small structured Browser Tool Result identifying the target, status/error, necessary bounded payload, truncation, and an Operation ID for potentially effectful calls; distinguish an Agent-local Browser Action Receipt from independent, read-only Website Effect Evidence without blind replay or website-level exactly-once promises; apply seven-day default Managed Download Retention only to unreferenced files in the dedicated directory; and allow an independently accepted low-impact Browser Capability Gate while any high-impact effect without reliably validated one-use owner approval remains denied.

ADR-0030 now accepts conservative classification, genuine end-to-end owner-approval acceptance, reuse of existing Agent receipt states, and lean independent platform checks. The precise safe subset, result/receipt schemas, verified approval transport, website-effect observations, managed-download reference tracking and rollout evidence remain unsettled. A generic webpage click may be consequential despite innocent labels. These are design decisions only.

## Browser privacy, file authority, trust and platforms — accepted eighth round (2026-10-20)

[ADR-0028](./adr/0028-browser-data-files-provenance-platform-acceptance.md) records four agreed boundaries. A Browser Page Observation is task-relevant and bounded; password/Cookie/token extraction is not a default output, and an on-demand screenshot may nevertheless disclose sensitive data. Browser Local Transfers reuse existing Agent filesystem permission and tools: explicit local upload paths and Managed Browser Downloads in a dedicated area, without a second browser file manager or new user-configured allowlist. Playwright-compatible Chromium must come from a reviewed trusted source with genuinely available integrity/provenance verification; absence, mismatch or offline unavailability fails rather than silently trusting a substitute. Platform Browser Acceptance is separate for Linux, WSL2 and native Windows, with staged enablement, real evidence and reuse of applicable unchanged tests.

ADR-0029 now fixes the default seven-day retention period for unreferenced managed downloads and the ability to gate safely classified low-impact functions separately. Numeric output budgets, download reference/cleanup mechanics, browser provenance verification details, platform rollout schedule and CI configuration remain unsettled. These decisions do not implement browser functionality.

## Browser tool and safe-execution choices — accepted seventh round (2026-10-20)

[ADR-0027](./adr/0027-browser-tools-visual-consent-and-recovery.md) records the accepted compact, curated atomic browser tool inventory across sessions, tabs, page observation/navigation, interaction and local file operations; bounded visual fallback for a Visual Browser Target when semantic identification fails; the Proposed Browser Action → explicit Browser Action Confirmation → execution boundary for each High-Impact Browser Action, with refusal if confirmation cannot be reliably established; and verification of retained browser/Profile state before recovering from a Browser Recovery Conflict. A screenshot location cannot be assumed fresh, an unverified confirmation is not authority, and an unknown outcome never authorizes blind replay or destruction of Profile/Receipt data.

ADR-0028 subsequently settles the direction for minimal browser data, reused Agent file authority, trusted compatible Chromium and independent platform acceptance. Exact tool signatures, visual freshness criteria, approval delivery and consumption, crash ownership probes, numeric privacy limits, file retention and release gates remain unsettled. These are design decisions only.

## Browser workflow coverage, tab targeting and safe clearing — accepted sixth round (2026-10-20)

[ADR-0026](./adr/0026-browser-capabilities-tab-and-approval-scope.md) confirms that the initial curated atomic tool scope covers ordinary end-to-end browser workflows (session and tab lifecycle, navigation, observation, click/fill/select/keyboard, screenshot, and local browser uploads/downloads) without unrestricted scripting. A stable Browser Tab ID belongs to the exact device/session, survives navigation and becomes invalid when its tab closes. Each High-Impact Browser Action requires one specific, non-transferable Browser Action Confirmation bound to device, session, tab, intended action and material target; changed targets must be re-approved. Automation Profile Clearing requires an explicit owner request and a provably inactive, resolved-operation state; ambiguous state fails closed rather than destroying local evidence or credentials.

ADR-0027 now chooses a curated compact inventory, bounded visual fallback, prepare/confirm/execute with fail-closed enforcement, and verified crash recovery. Exact tool signatures, human-confirmation transport/consumption, visual freshness, stale-lock ownership probes and cleanup implementation remain open. These are design choices, not deployed functionality.

## Browser tool atomicity and local action evidence — accepted fifth round (2026-10-20)

[ADR-0025](./adr/0025-atomic-browser-actions-and-receipts.md) accepts a minimal set of curated atomic browser MCP tools rather than unrestricted script or generic action dispatch; semantically identified, uniquely resolved Browser Element Targets with fail-safe handling of ambiguity and stale page state; Browser Local Transfers using explicitly authorized Agent-side upload paths and an Agent-managed download directory rather than default bulk MCP file forwarding; and stable Operation IDs / Browser Action Receipts for potentially effectful interactions. An uncertain action is never automatically replayed, and a browser-level success receipt is not proof of a website-side business commitment.

ADR-0026 has since resolved first-release capability coverage, stable tab targeting, one-use scoped confirmation and safe-state Profile clearing. Concrete tool names/schemas, locator fallback, path authorization, business outcome reconciliation and confirmation mechanics remain unsettled; this is documentation only.

## Browser interaction defaults and consequential effects — accepted fourth round (2026-10-20)

[ADR-0024](./adr/0024-browser-observation-and-confirmation.md) records four design choices: an Automation Browser Session is eligible for Agent-local cleanup after 30 idle minutes without clearing its Automation Browser Profile; headless browser mode is the default, with headed mode available only on a device with a usable graphical desktop; bounded semantic page inspection comes before on-demand screenshots; and every High-Impact Browser Action needs its own explicit Browser Action Confirmation before the external effect is committed. Ordinary navigation, observation and form preparation do not require confirmation for every interaction. Untrusted page content or prior device pairing cannot approve consequential actions.

ADR-0025 now resolves atomic tool granularity, semantic target preference, local file-transfer boundary and general operation-receipt policy. Exact activity tracking, confirmation mechanism, page-data/secret bounds, screenshot fallback, concrete tool schemas and platform acceptance remain open. The decisions are documentation-only and do not establish deployed browser capability.

## Browser automation provisioning, exclusivity and interruption — accepted third round (2026-10-20)

[ADR-0023](./adr/0023-browser-runtime-profile-interruption.md) records the accepted boundaries: on-demand Playwright-compatible Chromium installation on the Agent with no silent elevation for missing OS prerequisites; one active Automation Browser Session per persistent Automation Browser Profile; initially one dedicated Automation Browser Profile per device; and caller-disconnect retention until Agent-local idle cleanup without automatic action replay. Revoking device authorization prevents subsequent dispatch and requests best-effort shutdown of browser sessions on reachable Agents. Offline or compromised Agents cannot be confirmed stopped, and locally retained profile data is not implicitly erased.

ADR-0024 subsequently fixes the initial 30-minute idle threshold, headless default, semantic-first observation and per-high-impact-action confirmation boundary. Exact activity accounting, profile lock recovery, download trust, screenshot/page-data limits and confirmation implementation remain open; these are design decisions only, not deployed features.

## Browser automation runtime and session choices — accepted second round (2026-10-20)

[ADR-0022](./adr/0022-playwright-managed-browser-sessions.md) selects a Playwright-backed Agent browser adapter under the existing curated Remote Control MCP tool surface; it does not introduce a nested browser MCP Server. Linux and native Windows are the first supported **targets** (WSL2 belongs to the Linux path), with macOS later and **separate platform acceptance required**. An Automation Browser Profile retains local sign-in state independently of a Personal Browser Session. An Automation Browser Session has explicit identity, supports multiple MCP calls and explicit close, and is eligible for idle cleanup. Unknown or interrupted browser actions must not be blindly replayed.

ADR-0023 now resolves browser provisioning, initial profile cardinality, per-profile session exclusivity and disconnect/revocation policy. Concrete timeout durations, implementation-specific lock and cleanup recovery, profile data controls, exact tools and release criteria remain undecided. This extension does not change the Linux-only assumptions of historical v1 shipped functionality and does not constitute native Windows browser support.

## Browser automation extension — accepted first-round decisions (2026-10-20)

[ADR-0021](./adr/0021-browser-automation-extension.md) records the agreed architectural boundary: browser automation is an additional **Remote Control MCP** capability, not a separate MCP Worker; an independently managed Automation Browser Session comes before access to a Personal Browser Session; control is restricted to browser interactions rather than the full graphical desktop; existing pairing is reused but an explicit Browser Target is required and personal-session/sensitive actions have separate authorization boundaries.

These decisions are design-only. The [Browser Automation Design](./BROWSER-AUTOMATION-DESIGN.md) records the unresolved design tree; no browser tools, agent runtime, Windows coverage or production release are approved by this decision alone. The historical first-release exclusion of Graphical Desktop Control is unchanged.

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
