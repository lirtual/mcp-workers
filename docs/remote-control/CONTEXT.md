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

**Local Receipt Store**:
The Linux Agent's authoritative collection of Operation Receipts used to reconcile outcomes and suppress unintended repetition of state-changing requests across disconnections and restarts.
_Avoid_: Treating remote Worker transport acknowledgements, process logs, or a ChatGPT conversation as substitutes for a durable receipt.

**Receipt Retention Window**:
The period during which a previously admitted Operation ID remains available for outcome reconciliation and deduplication; an operation whose result is unknown is not presumed safe to repeat merely because a record is no longer present.
_Avoid_: Treating storage cleanup as proof that a previous operation had no effect.

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

## Unsettled boundaries — not approved yet

- The exact allowed tools and parameters; how destructive workspace writes, interactive process inputs and secret handling are authorized.
- Managed-session lifecycle details: stopping/canceling, output paging, quotas and behavior after device restart.
- Detailed reconciliation after the 30-day retention window, SQLite disk growth / disk-full recovery, Agent deployment rollback and token revocation remain to be decided; the initial SQLite choice and JSON migration / timeout / emergency-stop principles are recorded in ADR-0016.
- Actual ChatGPT/MCP Portal delivery of the separate static Bearer credential, token provisioning/rotation and denied-request acceptance; compatibility with arbitrary non-Portal MCP clients is not guaranteed.
- Actual permissions and secret exposure of the **confirmed existing normal Linux login account**, ingress compromise risk, limits (payload, output, time), supported tool shapes and rollout/monitoring policy.

Architecture and deployment implementation details belong in the research draft and ADRs, not in this vocabulary document.
