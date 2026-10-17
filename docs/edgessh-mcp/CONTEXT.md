# EdgeSSH MCP — Domain Context

Status: **baseline terminology only** (2026-10-17). This file defines terms independently of any proposed MCP integration architecture. No MCP product or deployment decision is approved yet.

## Language

**EdgeSSH Workspace**:
The self-hosted, single-administrator workspace that owns saved SSH hosts and provides interactive management of them. A workspace remains usable without an AI client or MCP integration.

**Saved Host**:
A workspace record describing how to reach and authenticate to one SSH endpoint. A saved record is not a live connection and does not by itself establish that the remote machine is online.

**SSH Credential**:
A password or private key authorizing authentication to a remote SSH account. A credential is distinct from the SSH server's identity and is not an MCP access token.

**SSH Host Identity**:
The identity of the remote SSH server, identified by its host public key and confirmed fingerprint. Verifying host identity prevents connecting to an unexpected server, even if an SSH credential is valid.

**SSH Session**:
One live, authenticated connection to a remote SSH server. Its lifetime is distinct from a Saved Host record and from any AI tool call.

**System Information Snapshot**:
Previously retrieved operating-system or system information associated with a Saved Host. A snapshot is not proof of current connectivity or current resource usage.

**MCP Tool Call**:
A request made by an authorized AI client to a named tool, with bounded inputs and a result. A tool call is not itself an SSH Session or an authorization to use every Saved Host.

## Vocabulary constraints

- Do not conflate SSH Host Identity, SSH Credential, and MCP caller authorization.
- Do not describe a saved or cached host as currently online without a fresh connection check.
- Do not call an unrestricted SSH shell or arbitrary command execution "read-only" because its name or intent sounds diagnostic.
- The future meaning and policy of an "AI-accessible host" are **unsettled**; see [DESIGN-INTERVIEW.md](./DESIGN-INTERVIEW.md). No new permission is implied by this terminology file.
