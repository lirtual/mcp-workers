# EdgeSSH MCP — Domain Context

Status: **Round 1 decisions recorded; overall design under interview** (2026-10-17). No production implementation or deployment approved.

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

## Settled product invariants — first decision round

- EdgeSSH stays usable as a standalone SSH workspace without any AI or MCP integration.
- The initial MCP feature scope includes arbitrary/parameterized SSH commands and SFTP file mutations, **not only read-only diagnostics**. Safety and lifecycle limits still require independent decisions.
- The MCP-eligible host set consists of **all Saved Hosts**, with no per-host opt-in.
- SSH Credentials remain under EdgeSSH ownership and are not returned to MCP callers.
- MCP caller authentication and SSH host authentication are distinct trust boundaries.
- This design is for one administrator, not a new multi-user permission or tenancy model.

## Terminology guardrails

- Do not describe arbitrary `exec` or SFTP writes as `read-only`.
- Do not imply all eligible hosts are reachable, authenticated, trusted, or online.
- Do not interpret workspace-wide host eligibility as permission to ignore SSH host-key verification.
- Do not claim every command succeeded after the connection was lost; preserve Unknown Outcome.
- Detailed limits, trust enrollment, user confirmation, retry behavior, and file-transfer scope **remain unresolved** in [the second-round interview](./DESIGN-INTERVIEW.md).
