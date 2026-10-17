# EdgeSSH MCP — Domain Context

Status: **Rounds 1 and 2 recorded; further session/receipt questions open** (2026-10-17). No production implementation or deployment approved.

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

## Settled product invariants — first and second decision rounds

- EdgeSSH stays usable as a standalone SSH workspace without any AI or MCP integration.
- The initial MCP feature scope includes arbitrary/parameterized SSH commands and SFTP file mutations, **not only read-only diagnostics**. Safety and lifecycle limits still require independent decisions.
- The MCP-eligible host set consists of **all Saved Hosts**, with no per-host opt-in.
- SSH Credentials remain under EdgeSSH ownership and are not returned to MCP callers.
- MCP caller authentication and SSH host authentication are distinct trust boundaries.
- This design is for one administrator, not a new multi-user permission or tenancy model.
- Initial capability includes interactive/persistent Shell sessions **and** background processes, not just one-shot `exec`. The precise persistence, process ownership and recovery contract remains open.
- A human must pre-verify SSH Host Identity in EdgeSSH. Unknown, absent or changed fingerprints must not be auto-accepted by AI tools.
- The dedicated caller credential permits unattended command and SFTP mutation requests; there is no separate EdgeSSH approval per tool call.
- State-changing operations need durable Operation Receipts and deduplication from the first release; their storage, session-input coverage and reconciliation details are still to be chosen.
- MCP SFTP scope is bounded text-oriented file operations, including mutation; not bulk binary transfer or streaming.

## Terminology guardrails

- Do not describe arbitrary `exec` or SFTP writes as `read-only`.
- Do not imply all eligible hosts are reachable, authenticated, trusted, or online.
- Do not interpret workspace-wide host eligibility as permission to ignore SSH host-key verification.
- Do not claim every command succeeded after the connection was lost; preserve Unknown Outcome.
- A recorded Managed SSH Session does not guarantee that its original TCP/SSH transport can survive interruption.
- Persistent receipts do not make remote side effects transactional or prove exactly-once execution.
- Detailed session recovery, ownership, stop, deduplication, storage, resource and text-transfer limits **remain unresolved** in [the third-round interview](./DESIGN-INTERVIEW.md).
