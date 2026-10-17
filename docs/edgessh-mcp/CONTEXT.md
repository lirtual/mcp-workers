# EdgeSSH MCP — Domain Context

Status: **Q1–Q20 decisions recorded; Q21 explicitly forbids any changes to the upstream/forked EdgeSSH project; architectural conflict Q22 OPEN** (2026-10-17). No production implementation or deployment approved.

This document records domain terms and product invariants, not implementation details. Technical options and the next unresolved decisions live in [DESIGN-INTERVIEW.md](./DESIGN-INTERVIEW.md).

## Language

**EdgeSSH Workspace**:
A self-hosted, single-administrator workspace that owns Saved Hosts and allows a human administrator to manage remote machines. Its human-operated functions are independently useful even when no AI integration is enabled.

**Saved Host**:
A workspace record describing a remote SSH endpoint, its identifying details, and an authentication method. A Saved Host is neither a live connection nor proof that the endpoint is online.

**SSH Credential**:
A password or private key that authenticates to a remote account. It is sensitive authorization material and must not be confused with the remote server's identity or an AI caller's access credential.

**SSH Host Identity**:
The identity of a remote SSH server, verified through its public host key and recorded fingerprint. Successfully authenticating an SSH account is not proof that the server itself was the intended target.

**SSH Session**:
A live, authenticated connection to a remote SSH endpoint, with its own establishment, operation, and teardown lifecycle. A session is different from both a Saved Host and an AI request.

**System Information Snapshot**:
Previously retrieved information associated with a Saved Host. A snapshot may be stale and is not evidence of current connectivity.

**MCP Caller**:
An AI client with valid authorization to request EdgeSSH MCP tools. Caller authorization is independent of both SSH Credential custody and SSH Host Identity verification.

**MCP Tool Call**:
A request by an MCP Caller to a named operation against the workspace. Each request has an identifiable target, inputs, outcome, and bounded execution context; it is not a general grant of network reachability.

**MCP-Eligible Host**:
Any Saved Host in the single-administrator workspace. Round 1 explicitly selects workspace-wide eligibility: there is no separate per-host MCP enrollment or allowlist. Eligibility alone does not mean SSH connectivity is currently possible or host-key verification may be skipped.

**Remote Command**:
A caller-specified command executed through a remote SSH account, potentially changing files, processes, or services. It is **not** presumed read-only based on its wording.

**Remote File Operation**:
A request to list, read, create, write, rename, or remove content using the remote account's file permissions. Mutations may have irreversible consequences.

**Execution Outcome**:
The observable outcome of a Remote Command or Remote File Operation: known completion, known rejection/failure before execution, or **Unknown Outcome** when a failure or disconnection prevents determining whether a change occurred.

**Unknown Outcome**:
A state where execution might have taken place but the client cannot prove the resulting state. A timeout or lost connection alone must not be treated as proof that a mutation did not happen.

**Managed SSH Session**:
A caller-identifiable interactive Shell session whose lifecycle may continue beyond the tool call that created it. A recorded session identifier is not proof that the underlying connection is still alive.

**Managed Remote Process**:
A remote process launched through an authorized managed session, with explicit lifecycle and stop semantics. Its identity and ownership must be established before the system claims it can control that process. A process may outlive the connection without remaining controllable.

**Interactive Input**:
Data sent into an existing Shell or process session. Such input may execute a state-changing command even if the tool name merely says "send input".

**Operation ID**:
The stable identity of one requested state-changing operation, used to recognize repeat submissions of that same intent. A new ID denotes a new intended operation, not a retry of the old effect.

**Operation Receipt**:
A durable record of an operation's admission, identity, known state and outcome, used to detect duplicates and reconcile uncertainty. A receipt cannot establish exactly-once remote effects.

**Unattended Operation**:
A remote operation permitted to proceed without a new interactive human approval for each call, within the authorized caller's SSH account privileges and the applicable system constraints.

**Lost Session**:
A previously established Managed SSH Session for which the service can no longer prove a live SSH connection and controllable channel. Its recorded identity and prior outcome may remain visible, but a lost session cannot safely accept new input or be automatically restarted.

**Session-Owned Job**:
A job started and controlled through a Managed SSH Session for which the service can still establish a valid ownership relationship to the live channel or process. Detachment or a reused process identifier alone is not sufficient ownership evidence.

**Operation Admission**:
The durable acceptance of a new Operation ID and its intended parameters *before* attempting the remote side effect. Admission is distinct from successful delivery, execution, and completion.

**Operation Conflict**:
A request that repeats an existing Operation ID with a different operation type, target or argument fingerprint. It must not be treated as a continuation of the first request.

**Session Stop**:
A request to terminate or close a particular Managed SSH Session or Session-Owned Job. The request's success at the control boundary does not prove that an independently running remote descendant process was terminated.

**Text File Mutation**:
An explicitly authorized, bounded request to create, overwrite, rename or delete remote text data. The operation may have partial or uncertain effects and is distinct from general binary file transfer.

**Unmodified Upstream Application**:
An independently maintained application whose source, deployment and runtime contract are not altered by this integration. The optional AI companion must not assume the application can expose a new internal API.

**Credential Custodian**:
The component that can read, decrypt and use authentication material to establish remote sessions. Changing the custodian changes the trust and exposure boundary, even when the same logical host list is reused.

**Reconciliation**:
Deliberate investigation of an operation with uncertain effects before choosing any new corrective intent. Inspection alone is not automatic authorization to re-execute the prior operation.

**Revoked Caller Credential**:
An access credential no longer valid for **new** MCP requests. Revocation is not evidence that an already-running remote action or an SSH connection has been terminated.

## Settled product invariants — first three decision rounds

- EdgeSSH stays usable as a standalone SSH workspace without any AI or MCP integration.
- The initial MCP feature scope includes arbitrary/parameterized SSH commands and SFTP file mutations, **not only read-only diagnostics**. Safety and lifecycle limits still require independent decisions.
- The MCP-eligible host set consists of **all Saved Hosts**, with no per-host opt-in.
- Original EdgeSSH SSH Credentials remain in EdgeSSH, but whether MCP may independently use imported/shared credentials is **unresolved under Q22**; the earlier EdgeSSH-only execution boundary Q3=A cannot currently coexist with Q21.
- MCP caller authentication and SSH host authentication are distinct trust boundaries.
- This design is for one administrator, not a new multi-user permission or tenancy model.
- Initial capability includes interactive/persistent Shell sessions **and** background processes, not just one-shot `exec`. A live session may outlast the originating MCP call, but is not guaranteed to survive a Worker/SSH disconnect.
- A human must pre-verify SSH Host Identity in EdgeSSH. Unknown, absent or changed fingerprints must not be auto-accepted by AI tools.
- The dedicated caller credential permits unattended command and SFTP mutation requests; there is no separate EdgeSSH approval per tool call.
- State-changing operations require an Operation ID and durable Operation Receipt, **including Interactive Input**. Repeat submissions with matching intent must not dispatch side effects twice; conflicting intent must be rejected.
- **Historical Q14=A**, locating Operation Admission in EdgeSSH, conflicts with the now mandatory unmodified-EdgeSSH boundary. The authoritative future custodian/dispatcher must be selected under Q22 before implementation.
- MCP SFTP scope is bounded UTF-8 text-oriented file operations, including mutation; not bulk binary transfer or streaming. Overwrite or destructive intent must be explicit.
- On disconnection, record a Lost Session and last-known bounded output; never automatically reconnect to its old PTY or rerun a previous command.
- Only session-attached, provably Session-Owned Jobs may be controlled or stopped. Do not claim to manage detached processes across SSH disconnections.
- Managed SSH Sessions must have finite concurrency, idle/absolute lifetime and output limits. Their precise values are implementation details, not agreed requirements.

## Accepted fourth-round product choices — conditional on Q22

- **Q17=A:** Ordinary known-terminal operation receipts remain for a 30-day normal window; unresolved `unknown` identities retain minimal non-replay markers beyond that window until deliberate reconciliation. Stored receipts should not contain original commands, file payloads, private keys or passwords.
- **Q18=A:** Never automatically retry or compensate an uncertain SSH/SFTP side effect; the human checks remote state before deliberately initiating a new operation under a fresh identity.
- **Q19=A:** If durable admission cannot be recorded, new effectful operations and interactive input fail closed. An authenticated stop/close remains a narrow best-effort exception only for a provably owned live session; its unrecorded outcome must be stated as uncertain.
- **Q20=A:** A revoked/rotated MCP credential cannot authorize new tool calls. Rotation alone does not guarantee that a live SSH session or detached remote action is immediately killed; bounded session expiration and deliberate authorized stop remain necessary.
- **Q21=constraint (operator correction):** EdgeSSH is a third-party-maintained **fork**, not an application the operator wishes to change. The integration must make **zero changes** to its source, deployed Worker, routes, secrets, storage schema, or runtime behavior; all new development/deployment belongs to `mcp-workers`. This supersedes the previously proposed "extend EdgeSSH with a private RPC interface" release plan.

## Unresolved compatibility — requires Q22

- **Previously accepted Q3=A** placed SSH credential decryption and remote command execution *only* inside EdgeSSH. The existing unchanged EdgeSSH does not expose a server-to-server SSH execute service. This outcome therefore cannot currently be implemented together with Q21 and the accepted broad unattended MCP capabilities Q2=B/Q6=B.
- **Previously accepted Q14=A** placed authoritative MCP admission/receipts in EdgeSSH storage. Doing so requires executable enforcement in the actual dispatch path. The unchanged application has no such MCP admission path. A separate MCP worker can own its receipts only if the architecture decision is explicitly changed.
- **Previously accepted Q4=B** means all Saved Hosts are *eligible*, not that an unmodified independent MCP Worker can automatically retrieve them. Actual access to host metadata and credentials remains unresolved.
- Existing Q7=A SSH host identity confirmation stays a security requirement; whether a new custodian can safely import the confirmed fingerprint without modifying EdgeSSH requires specification and validation.

No alternative architecture is accepted yet. See [Q22 in DESIGN-INTERVIEW.md](./DESIGN-INTERVIEW.md).

## Terminology guardrails

- Do not describe arbitrary `exec` or SFTP writes as `read-only`.
- Do not imply all eligible hosts are reachable, authenticated, trusted, or online.
- Do not interpret workspace-wide host eligibility as permission to ignore SSH host-key verification.
- Do not claim every command succeeded after the connection was lost; preserve Unknown Outcome.
- A recorded Managed SSH Session does not guarantee that its original TCP/SSH transport can survive interruption.
- Persistent receipts do not make remote side effects transactional or prove exactly-once execution.
- A live Shell channel or remote process cannot be proved owned using a PID alone after reconnection; stopped channel != guaranteed termination of descendants.
- Q17–Q20 settle the high-level retention, reconciliation, failure-stop, and revocation policies **conditionally**. Their enforcing service depends on the pending architecture choice.
- The no-EdgeSSH-changes boundary is accepted for Q21; actual MCP-only release sequencing/rollback depends on Q22. Nothing recorded here authorizes a deployment.
