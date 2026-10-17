# EdgeSSH MCP — Grilling with Docs · Round 3

Status: **Rounds 1 and 2 operator decisions accepted; round 3 open; final design NOT APPROVED**.
Date: 2026-10-17
Source repos: [EdgeSSH](https://github.com/lirtual/EdgeSSH) and [mcp-workers](https://github.com/lirtual/mcp-workers).
Decision records: [ADR-0001](./adr/0001-edgessh-mcp-cross-repo-boundary.md) and [ADR-0002](./adr/0002-managed-ssh-sessions-and-operation-receipts.md).
This branch and PR contain **documentation only**: no runtime, credentials, Portal connection, Cloudflare bindings or production deployments were changed.

## Round 1 — signed-off decisions (2026-10-17)

| ID | Selected | Effective requirement |
| --- | --- | --- |
| Q1 | **A** | Only same-Cloudflare-account EdgeSSH + MCP Worker in v1; no cross-account bridge |
| Q2 | **B** | From the first release, caller-specified SSH commands **and** SFTP write/mutation capability; not read-only-only |
| Q3 | **A** | EdgeSSH is sole owner of SSH credentials, key decryption and remote SSH execution; no credential export to MCP |
| Q4 | **B** | A valid EdgeSSH MCP caller can select **any saved host**; no per-host opt-in |
| Q5 | **A** | Existing Portal Bearer approach with a distinct EdgeSSH MCP secret; no shared token, no first-release OAuth service |

These are deliberate choices, including the broader security exposure of Q2=B + Q4=B. Do **not** reinterpret them as opt-in host access, read-only commands, or a staged read-only-only v1 without asking the operator.

## Baseline reconnaissance (verified)

1. EdgeSSH owns encrypted host credentials in its D1-backed workspace. Its browser `POST /api/hosts/:id/credentials` returns credentials to the authenticated Web UI and **must not** be reused as an MCP tool or data source.
2. The SSH connection is currently a browser-WebSocket-driven `SSHSession` inside `SSHSessionDO`. `SSHChannel.buildExecRequest()` exists for internal probes/process actions, but a noninteractive, standalone RPC execution path and general command result/exit semantics remain to be built and tested.
3. Existing SFTP operations include listing, reading/download, creating/uploading, renaming, deletion. The SFTP handler is also browser-session oriented and currently bounds transfers to 64 MiB; that limit is **not automatically** an appropriate MCP payload limit.
4. Current host-key behavior asks the browser to confirm unknown/changed SHA256 fingerprints. An unattended MCP path must define what happens if that interactive step is missing.
5. EdgeSSH currently blocks private/reserved SSH targets and rejects outbound TCP port 25. MCP must not become an SSRF bypass or private-network tunnel.
6. The `mcp-workers` repo is intentionally multi-app, not a central business logic platform. Reuse its MCP ingress mechanism and retain independently deployable apps.
7. The operator's connected Cloudflare account currently has both `edgessh` and existing MCP Workers. Same-account Service Binding + a named `WorkerEntrypoint` is supported by Cloudflare [RPC docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/) and [binding docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/); this does not mean authorization is propagated automatically.

## Candidate design honoring Q1–Q10 (implementation NOT approved)

```text
MCP Client / MCP Portal
        |
        v
mcp-workers/apps/edgessh-mcp-worker
  - independent static Bearer authentication (secret unique to this app)
  - tool names, input validation, output limits, error mapping
        |
        | same-account Service Binding to a named RPC entrypoint
        v
EdgeSSH Worker [independent WebSSH product]
  - small internal operations surface; does not return credentials
  - owns single-admin workspace, host lookup, credentials, target and trust checks
  - managed interactive SSH sessions + owned background operations, as well as bounded text SFTP operations, using existing SSH core
        |
        v
SSH server (privileges of stored SSH login account)
```

**Optional integration invariant:** EdgeSSH must remain fully operable when the MCP adapter is absent or its binding is not configured. The integration must not silently change browser routes, login or storage migration. No new public hostname, token-bypass HTTP route, credential-sharing database or Agent.

**Security truth:** The accepted feature set can modify or destroy remote state. A dedicated Bearer is an extremely powerful credential for the entire host collection; it is **not equivalent to per-operation human approval or a safety sandbox**. Model-generated commands must be treated as untrusted intentions and validated as structured inputs, not as authorized merely because the MCP caller is authenticated.

**Main implementation feasibility gate:** prove non-browser SSH operation and interactive PTY/session support (input, bounded output polling, stop, disconnect, separate tool-call lifetimes), plus headless text SFTP, against the existing SSH core. The current `SSHSession` constructor takes a WebSocket; that browser-shaped API cannot be treated as a ready-made headless execution interface. Pay particular attention to stdout/stderr/exit-status visibility, private-key memory lifetime, process identity and cleanup. Reuse proven protocol code; do not build a second SSH implementation.

**Runtime lifecycle caveat:** Durable Object session coordination does not mean the remote TCP/SSH connection, PTY, or process survives eviction, deployment, or network failure. Cloudflare's [DO lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/) and [TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) docs describe constraints on outbound connection liveness (including a 15-minute *keep-alive protection window*, which is not a maximum guaranteed SSH session length). Design must report lost/unknown outcomes, not silently replay prior commands or reattach to an unverifiable process.

**Receipt boundary:** Because EdgeSSH actually admits/dispatches SSH operations, deduplication must be enforced before dispatch **on the EdgeSSH side**. Recording an operation solely in the MCP adapter is insufficient if the adapter loses its response. Remote command execution, interactive Shell input and SFTP mutations are potentially effectful; receipt coverage for each is a Round 3 decision. No database storage choice or schema is approved yet.

## Round 2 — operator decisions accepted (2026-10-17)

| ID | Selected | Effective requirement |
| --- | --- | --- |
| Q6 | **B** | First-release persistent/interactive SSH Shell and background processes with managed session identity, status, stop and recovery semantics. **Does not mean indefinite connection uptime or automatic process resurrection.** |
| Q7 | **A** | Human verifies host fingerprint in EdgeSSH before unattended MCP use; missing, new and changed host fingerprints fail closed. |
| Q8 | **A** | Dedicated MCP Bearer permits unattended commands and SFTP mutations, without an extra interactive approval on each tool call. |
| Q9 | **B** | Persistent operation receipts and duplicate detection for state-changing calls belong in the first release; exact storage, input coverage and reconciliation rules not yet chosen. |
| Q10 | **A** | MCP SFTP exposes bounded text-oriented reads/writes and common file/directory mutations; bulk binary transfer and streaming stay in the browser product. |

These decisions are **accepted requirements**, not production authorization. Q6=B and Q9=B increase implementation scope; do not relabel them as one-shot execution or receipt-free retries in order to reduce complexity.

### Scope stress test — implications now visible

- **Persistent interactive sessions** must survive the *MCP HTTP call* ending. They are **not** guaranteed to survive worker deployment, DO eviction, SSH disconnection or unexpected remote exit. Retained identifiers may remain queryable as lost/ended while the original TCP session is gone.
- **Background processes** are not automatically "owned" merely because a remote Shell started them. `kill <pid>` without proven identity risks controlling unrelated processes or reused PIDs. The first-release lifecycle/stop contract needs an explicit boundary.
- **Interactive Shell input** is at least as dangerous as `exec(command)`: sending `rm -rf ...\n` can mutate state, and partial delivery makes completion uncertain. A generic "read-only session" designation does not solve that.
- **Receipt durability** must be established before dispatch if it is intended to prevent duplicates. It still cannot atomically coordinate a local record with remote side effects. A duplicate call with the same ID and different payload must conflict, not execute anew.
- **Unattended + all hosts** gives one EdgeSSH MCP Bearer highly privileged access to every saved SSH account, including any root-capable account. There is no per-host or per-operation server-side consent after initial host-key verification. This is a consciously accepted trust exposure, not "safe" merely due to Service Binding.
- **Text SFTP write operations** may overwrite important files and must have explicit overwrite/deletion intent and a bounded payload. The browser's current 64 MiB transfer limit is not an MCP response size policy.
- **No automatically safe retries**: a receipt can return an existing known result or unresolved status for the same ID. It must never trigger a blind re-dispatch of an operation whose effect might have started. Retained "unknown" must not be silently treated as rejection.
- **Isolation**: the optional MCP runtime and any long-lived managed sessions must not change base EdgeSSH's browser session/credential-security behavior.

## Round 3 — independent frontier (awaiting operator decisions)

**Q11 · Session recovery after disconnect/deployment**
- A (**recommended**): Preserve session ID and last-known status/limited output; on lost SSH TCP/session mark lost/unknown, never automatically reconnect to the old PTY or rerun its command. A new SSH session requires an explicit new request. "Recovery" means honest state inspection and deliberate re-establishment, not resurrecting the old process.
- B: Automatically reconnect and restore/restart interactive sessions and processes. Requires a remote supervisor/agent and risks repeating side effects; not generally achievable from SSH transport alone.

**Q12 · Ownership of remote background processes and stopping**
- A (**recommended**): Support long-running, session-attached commands while the SSH session is actually live; control only **provably session-owned** channels/jobs. Explicit stop/close may end the session but cannot promise termination of detached descendants. Do not support autonomous detached PID tracking or arbitrary `kill PID` as an MCP management primitive.
- B: Manage detached remote jobs across broken SSH connections, persist/recover PID identity, and stop them independently. Needs stronger remote ownership proof/supervision and additional life-cycle code.

**Q13 · Receipt scope for Shell input**
- A (**recommended**): Every potentially state-changing admission, including exec/start, interactive input and SFTP create/write/rename/delete/mkdir, requires a stable operation ID and matching parameter digest; duplicate IDs return recorded state instead of sending bytes again. Read-only status/list operations do not need receipts.
- B: Receipts protect only discrete exec and SFTP writes; raw interactive input is allowed without deduplication, making accidental command re-delivery possible.

**Q14 · Receipt authority and storage**
- A (**recommended**): The authoritative admission/receipt record belongs to EdgeSSH and uses its **existing durable storage**, with atomic unique-ID admission before SSH dispatch, final/unknown states, and explicit conflict on changed arguments. Live session state stays with the existing SSH lifecycle owner; no second operation platform/DB.
- B: Add an independent durable job service/queue or manage receipt state in the MCP adapter, creating additional write/transport state and distributed reconciliation.

**Q15 · Session resource bounds**
- A (**recommended**): Start with small fixed concurrency per host/overall, bounded idle + absolute session lifetime and a bounded output ring; refuse extra sessions instead of creating a distributed queue or unbounded remote shell pool. Exact numerical limits are a later spec/test parameter.
- B: Allow open-ended concurrent sessions and effectively unlimited lifetimes, with automatic resource expansion or a distributed scheduler.

**Q16 · SFTP text mutation contract**
- A (**recommended**): UTF-8 text with small fixed request/response limits, explicit `overwrite` or destructive intent and safe handling of partial-write/rename uncertainty. This does not claim atomic replacement across every SFTP server.
- B: Implicit overwrite of existing paths and transfers up to the browser's 64 MiB limit, without a small MCP-specific data contract.

## Next decisions dependent on Round 3

- Only after Q11/Q12: precise allowed session APIs, remote process ownership evidence, whether an emergency stop remains possible when durable receipt writes fail, and any remote process orphan reconciliation.
- Only after Q13/Q14: receipt retention for unresolved operations, admission-failure behavior, contention and the actual storage schema.
- Only after Q15/Q16: defaults for time limits/concurrency/output/text transfer, file encoding and text-write replacement/rollback tests.
- Then: release compatibility, rollback, and final human design consensus. No software implementation, infrastructure deployment or live SSH tests are authorized by this document.

## Preliminary acceptance risks / gates — no test result claimed

- Existing WebSSH/UI/login must function unchanged with integration disabled.
- An MCP caller cannot read SSH private keys, plaintext passwords, encryption keys or use credential-returning browser APIs.
- Invalid/missing distinct MCP Bearer and a missing Service Binding must fail closed on MCP, without disabling WebSSH.
- A bound Worker call must reach only explicitly exported internal methods, and target-side validation must re-check operation, host, port, and host-key identity.
- All saved hosts are discoverable and eligible (Q4=B), but trust and connection failure remain explicit; no fabricated online status.
- Arbitrary shell is mutating/high risk and cannot be labeled read-only.
- Timeouts/disconnects must not be reported as successful or definitely unexecuted when result is unknown.
- Live SSH and SFTP mutations should be tested against owned disposable SSH fixtures, not production servers.
- API payload validation must guard result-size and argument-size limits, including malicious/untrusted tool output; Cloudflare Worker resource ceilings must be measured, not guessed.
- Source deployment of EdgeSSH and MCP Worker must stay independent. No release authorization is implied by this interview.

## Interview completion gate

After Q11–Q16 are selected, resolve only remaining dependent lifecycle/receipt/release questions. The design is not finalized until the operator explicitly approves the synthesis. Only then begin `to-spec` or `to-tickets`. No code or production change during grilling.
