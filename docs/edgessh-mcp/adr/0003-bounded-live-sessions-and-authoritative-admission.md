# ADR-0003 — Bounded live sessions, authoritative admission and safe text SFTP

Status: **Round 3 Q11–Q13/Q15–Q16 remain accepted; historical Q14=A (EdgeSSH-only receipt authority) is SUPERSEDED by Q22=B, [ADR-0005](./0005-independent-mcp-ssh-shared-edgessh-credentials.md). No implementation authorization.**
Design record only. No production implementation, deployment or integration enablement authorized.
Related: [ADR-0001](./0001-edgessh-mcp-cross-repo-boundary.md), [ADR-0002](./0002-managed-ssh-sessions-and-operation-receipts.md), [design interview](../DESIGN-INTERVIEW.md).

## Context

The first two rounds originally proposed a same-account MCP adapter with exclusive EdgeSSH credential ownership (**later superseded by Q22=B**), all Saved Hosts accessible to an authorized dedicated MCP bearer, unattended commands and SFTP mutations, managed interactive SSH plus background tasks, human-pinned host keys, and durable operation receipts.

Real EdgeSSH SSH connections currently live in browser WebSocket-driven `SSHSession` objects under `SSHSessionDO`, with D1 storing the encrypted host records. The Durable Object's existing browser restoration handling closes orphaned sockets with a reconnect-required status after restart; no general autonomous remote process supervisor exists. A persisted session ID cannot restore the original SSH transport by itself. Cloudflare's outbound TCP socket lifecycle only prevents Durable Object eviction for a limited protection window, **not** indefinite process/session persistence.

The operator chose minimal bounded management rather than reproducing a general-purpose remote-control agent or a cloud job platform.

## Accepted decisions (2026-10-17)

1. **Q11=A — Honest session loss and explicit re-establishment.** A managed session may persist beyond the originating MCP HTTP request, with its session ID, last-known bounded output and state queryable. If its SSH connection is lost or its underlying DO is restarted, record a lost/unknown state. No automatic terminal restoration, no transparent PTY reconnect, no rerunning the command. Only a new, explicitly authorized session start may establish another SSH connection. A lost connection does not prove remote side effects were reverted.
2. **Q12=A — Session-owned jobs only.** Permit background or long-running commands only while the current live SSH session still has a provably owned channel/job. Stop/close must target that identity and may truthfully report uncertain remote effect. Do not infer ownership from an arbitrary PID after disconnection, manage detached process trees across SSH outages, install a remote Agent, or expose `kill_any_pid` as a new MCP capability. A session close cannot promise death of detached descendants.
3. **Q13=A — Input included in durable receipt coverage.** A unique stable Operation ID plus matching operation/host/session/argument digest is required for every potentially mutating admission, including session start, `exec`, **interactive PTY input chunks**, and SFTP file/directory mutations. A second delivery of the same identity returns the existing outcome and cannot re-send bytes or repeat execution. Different payload under the same ID is a conflict. Read-only status/output/list probes need no mutation receipts. Input batching/granularity is a Spec detail, not an exemption for arbitrary character input.
4. **Q14=A — EdgeSSH-owned receipt admission (HISTORICAL, SUPERSEDED by Q22=B).** Originally Q14 placed atomic operation admission in EdgeSSH before SSH dispatch. The independently maintained EdgeSSH fork cannot be modified and does not provide an MCP execution/receipt API. **Current accepted resolution:** the MCP Worker itself is the SSH execution authority and owns durable atomic receipt admission before it dispatches effects. Use a SQLite-backed DO within that one MCP Worker as the minimal candidate, not a receipt table or migration in the shared EdgeSSH D1, and not a new independent receipt service. See [ADR-0005](./0005-independent-mcp-ssh-shared-edgessh-credentials.md).
5. **Q15=A — Finite sessions and output.** Enforce simple fixed per-host/overall concurrency, idle and absolute session lifetimes, and bounded output retention. Refuse excess sessions (do not queue them for later). Preserve independent WebSSH functionality; the fixed numerical limits and CPU/DO socket behavior must be validated in the Spec. Long-running here means outliving an MCP call, **not** an unlimited server-side lease.
6. **Q16=A — Bounded explicit UTF-8 file edits.** MCP file operations use a small text-only request/response envelope with UTF-8 validation, size limits and explicit overwrite/destructive intent. List, read, create/write, rename, delete and directory actions stay within the accepted Q10 scope. Treat partial writes, path conflicts and rename behavior according to observable outcomes; do **not** claim atomic replacement on all SFTP servers or expose the browser's 64 MiB binary-transfer API to MCP.

## Invariants / security implications

- `Operation Receipt` is a replay/admission defense, **not** exactly-once remote execution, rollback or remote process supervision.
- Side effects that may have crossed the SSH boundary when a disconnect or timeout occurs must retain an explicit **Unknown Outcome** until reconciled. No blind automatic resend on process/transport recovery.
- The origin/secret of the dedicated MCP bearer is a broad authorization capability: Q4=B and Q8=A still expose **all stored SSH accounts** to unattended model-driven actions, subject to pinned host identity and normal remote account privileges.
- **Current Q22=B boundary:** MCP is the SSH executor, and therefore must enforce host/operation/argument validation and durable receipt admission *before* outbound SSH effects. There is no EdgeSSH RPC. The MCP D1 binding can write even though the app must issue fixed SELECTs only; this is a documented residual risk. Credential output remains forbidden.
- The connection owner may stop only a provably live session/channel/job. A PID may be reused; a lost session cannot be considered still owned by ID alone.
- Finite bounds and fail-closed admission matter for free/limited Cloudflare resources: no promise that a TCP connection is indefinitely retained or a post-request background job will always run to completion.
- Absent MCP integration or failure of its binding cannot prevent the independently deployed browser EdgeSSH application from working.

## Consequences

**Benefits:** preserves prior Q6=B interactive/persistent-Shell promise in a truthful, bounded way; makes interactive input replay protection explicit; scopes background control to verifiable SSH ownership; reuses existing storage and SSH machinery; avoids extra service/queue, remote supervisor and binary transfer protocol.

**Costs:** identity/receipt bookkeeping for interactive input; additional internal session and bounded-output control surface; missed/unknown outcomes need deliberate investigation; live sessions terminate or become unreachable at network/runtime failure; potentially orphaned remote jobs cannot automatically be killed or safely reattached.

**Rejected:** automatic PTY/process resurrection (Q11=B), detached PID/job ownership platform (Q12=B), uncovered interactive input (Q13=B), unbounded session pool (Q15=B), implicit overwrite/large binary MCP transfers (Q16=B). **Historical Q14=B rejection has been overridden by Q22=B**, which makes the actual MCP executor authoritative for its own receipts.

## Final architectural resolution

Q17–Q20 are accepted; Q21 forbids EdgeSSH changes. **Q22=B was accepted**, replacing the old Q14/A receiver with an MCP-side atomic receipt authority and independent SSH implementation, without changing EdgeSSH. See [ADR-0005](./0005-independent-mcp-ssh-shared-edgessh-credentials.md) and [final review](../FINAL-ARCHITECTURE-REVIEW.md). No current code/production action is authorized.

No code, D1 migration, live SSH action, Cloudflare setting or release authorization is implied.
