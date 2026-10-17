# ADR-0003 — Bounded live sessions, authoritative admission and safe text SFTP

Status: **Historical Q11–Q16 accepted on 2026-10-17; Q14=A EdgeSSH storage/execution authority is BLOCKED by no-fork-changes Q21 in [ADR-0004](./0004-unmodified-edgessh-and-reliability-policy.md). Q22 open.**
Design record only. No production implementation, deployment or integration enablement authorized.
Related: [ADR-0001](./0001-edgessh-mcp-cross-repo-boundary.md), [ADR-0002](./0002-managed-ssh-sessions-and-operation-receipts.md), [design interview](../DESIGN-INTERVIEW.md).

## Context

The first two rounds chose a same-account MCP adapter, exclusive EdgeSSH credential ownership, all Saved Hosts accessible to an authorized dedicated MCP bearer, unattended commands and SFTP mutations, managed interactive SSH plus background tasks, human-pinned host keys, and durable operation receipts.

Real EdgeSSH SSH connections currently live in browser WebSocket-driven `SSHSession` objects under `SSHSessionDO`, with D1 storing the encrypted host records. The Durable Object's existing browser restoration handling closes orphaned sockets with a reconnect-required status after restart; no general autonomous remote process supervisor exists. A persisted session ID cannot restore the original SSH transport by itself. Cloudflare's outbound TCP socket lifecycle only prevents Durable Object eviction for a limited protection window, **not** indefinite process/session persistence.

The operator chose minimal bounded management rather than reproducing a general-purpose remote-control agent or a cloud job platform.

## Accepted decisions (2026-10-17)

1. **Q11=A — Honest session loss and explicit re-establishment.** A managed session may persist beyond the originating MCP HTTP request, with its session ID, last-known bounded output and state queryable. If its SSH connection is lost or its underlying DO is restarted, record a lost/unknown state. No automatic terminal restoration, no transparent PTY reconnect, no rerunning the command. Only a new, explicitly authorized session start may establish another SSH connection. A lost connection does not prove remote side effects were reverted.
2. **Q12=A — Session-owned jobs only.** Permit background or long-running commands only while the current live SSH session still has a provably owned channel/job. Stop/close must target that identity and may truthfully report uncertain remote effect. Do not infer ownership from an arbitrary PID after disconnection, manage detached process trees across SSH outages, install a remote Agent, or expose `kill_any_pid` as a new MCP capability. A session close cannot promise death of detached descendants.
3. **Q13=A — Input included in durable receipt coverage.** A unique stable Operation ID plus matching operation/host/session/argument digest is required for every potentially mutating admission, including session start, `exec`, **interactive PTY input chunks**, and SFTP file/directory mutations. A second delivery of the same identity returns the existing outcome and cannot re-send bytes or repeat execution. Different payload under the same ID is a conflict. Read-only status/output/list probes need no mutation receipts. Input batching/granularity is a Spec detail, not an exemption for arbitrary character input.
4. **Q14=A — EdgeSSH-owned existing durable store (HISTORICAL / CURRENTLY BLOCKED).** EdgeSSH is the authoritative receiver of operation admission/receipt records, atomically claims unique operations before dispatch, and remains the only side allowed to transmit side effects. Reuse existing EdgeSSH durable storage; **do not** build a second receipt service/database/queue or rely on a solely MCP-side ledger. Live channel state belongs to the existing SSH session owner. The choice between a small additive D1 receipt table and existing DO storage/layout, as well as exact transaction mechanics, is a constrained implementation detail for the eventual Spec and tests, not authorization for migration today.
5. **Q15=A — Finite sessions and output.** Enforce simple fixed per-host/overall concurrency, idle and absolute session lifetimes, and bounded output retention. Refuse excess sessions (do not queue them for later). Preserve independent WebSSH functionality; the fixed numerical limits and CPU/DO socket behavior must be validated in the Spec. Long-running here means outliving an MCP call, **not** an unlimited server-side lease.
6. **Q16=A — Bounded explicit UTF-8 file edits.** MCP file operations use a small text-only request/response envelope with UTF-8 validation, size limits and explicit overwrite/destructive intent. List, read, create/write, rename, delete and directory actions stay within the accepted Q10 scope. Treat partial writes, path conflicts and rename behavior according to observable outcomes; do **not** claim atomic replacement on all SFTP servers or expose the browser's 64 MiB binary-transfer API to MCP.

## Invariants / security implications

- `Operation Receipt` is a replay/admission defense, **not** exactly-once remote execution, rollback or remote process supervision.
- Side effects that may have crossed the SSH boundary when a disconnect or timeout occurs must retain an explicit **Unknown Outcome** until reconciled. No blind automatic resend on process/transport recovery.
- The origin/secret of the dedicated MCP bearer is a broad authorization capability: Q4=B and Q8=A still expose **all stored SSH accounts** to unattended model-driven actions, subject to pinned host identity and normal remote account privileges.
- Target-side (EdgeSSH) host/operation/argument validation and receipt admission must hold even if the MCP adapter is compromised or bypassed through another same-account service binding. Named RPC methods must never export credentials. The exact in-account binding trust model and caller capability checks remain an implementation audit concern.
- The connection owner may stop only a provably live session/channel/job. A PID may be reused; a lost session cannot be considered still owned by ID alone.
- Finite bounds and fail-closed admission matter for free/limited Cloudflare resources: no promise that a TCP connection is indefinitely retained or a post-request background job will always run to completion.
- Absent MCP integration or failure of its binding cannot prevent the independently deployed browser EdgeSSH application from working.

## Consequences

**Benefits:** preserves prior Q6=B interactive/persistent-Shell promise in a truthful, bounded way; makes interactive input replay protection explicit; scopes background control to verifiable SSH ownership; reuses existing storage and SSH machinery; avoids extra service/queue, remote supervisor and binary transfer protocol.

**Costs:** identity/receipt bookkeeping for interactive input; additional internal session and bounded-output control surface; missed/unknown outcomes need deliberate investigation; live sessions terminate or become unreachable at network/runtime failure; potentially orphaned remote jobs cannot automatically be killed or safely reattached.

**Rejected:** automatic PTY/process resurrection (Q11=B), detached PID/job ownership platform (Q12=B), uncovered interactive input (Q13=B), MCP-only or external receipt authority (Q14=B), unbounded session pool (Q15=B), implicit overwrite/large binary MCP transfers (Q16=B).

## Unsettled follow-up policy (Round 4)

Q17–Q20 have now been accepted. Q21 forbids EdgeSSH changes, so Q14's EdgeSSH admission hook is not implementable without a suitable existing API. Q22 in the design interview must explicitly resolve future credential/execution and receipt authority. No current code/production action is authorized.

No code, D1 migration, live SSH action, Cloudflare setting or release authorization is implied.
