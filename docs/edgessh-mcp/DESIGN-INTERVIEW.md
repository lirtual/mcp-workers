# EdgeSSH MCP — Grilling with Docs · Critical Q22 compatibility decision

Status: **Q17–Q20 accepted; Q21 no-EdgeSSH-changes constraint accepted; Q22 BLOCKS architecture; final design NOT APPROVED**.
Date: 2026-10-17
Source repos: [EdgeSSH](https://github.com/lirtual/EdgeSSH) and [mcp-workers](https://github.com/lirtual/mcp-workers).
Decision records: [ADR-0001](./adr/0001-edgessh-mcp-cross-repo-boundary.md), [ADR-0002](./adr/0002-managed-ssh-sessions-and-operation-receipts.md), , [ADR-0003](./adr/0003-bounded-live-sessions-and-authoritative-admission.md), and [ADR-0004](./adr/0004-unmodified-edgessh-and-reliability-policy.md).
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

## 2026-10-17 operator correction: DO NOT MODIFY EDGESSH — previous candidate blocked

The operator states EdgeSSH is a fork of a project they do **not** maintain and no changes to EdgeSSH will be considered. The previously drawn named private RPC entrypoint would have to be **implemented in EdgeSSH**; this is now forbidden. Merely binding to `edgessh` does **not** make unimplemented SSH RPC methods exist. EdgeSSH's `/api/hosts/:id/credentials` returns plaintext credentials for authenticated browser use; the existing SSH/SFTP entrypoints use authenticated/ticketed WebSocket flows, not an operation-receipt-protected server-side execute RPC. Its Cloudflare Access/GitHub user credentials are not the MCP Portal Bearer.

This creates a hard Q3=A and Q14=A conflict: they require EdgeSSH to perform credential decryption, SSH execution and authoritative receipt admission, but the unchanged EdgeSSH does not expose those operations to the companion. The broad SSH/SFTP/interactive scope Q2=B/Q6=B cannot be delivered without changing **either** the credential/execution trust model **or** the feature promise. **Do not implement, publish, or call the architecture approved until Q22 is answered.**

The prior diagram below is retained only as **superseded historical proposal**, not a viable plan under Q21. Alternatives appear in [ADR-0004](./adr/0004-unmodified-edgessh-and-reliability-policy.md).

## Superseded candidate design honoring Q1–Q16 (not implementable under corrected Q21)

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

**Receipt boundary:** Q13=A/Q14=A now require EdgeSSH-side durable claim of every potentially mutating input, including interactive PTY chunks, before SSH dispatch. The MCP adapter may validate and pass operation IDs but cannot be the sole authority. A unique-ID conflict must not execute. Existing EdgeSSH storage is reused, without deciding a new database or final schema yet. A locally durable record cannot atomically confirm effects on the remote SSH server.

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

## Round 3 — operator decisions accepted (2026-10-17)

| ID | Selected | Effective requirement |
| --- | --- | --- |
| Q11 | **A** | On SSH disconnect/DO restart retain session identity and bounded last-known state, mark lost/unknown; never automatically reconnect old PTY or rerun commands. |
| Q12 | **A** | Manage only jobs/channels demonstrably owned by a **live** SSH session; no detached process supervisor or PID-based reattachment after outage. |
| Q13 | **A** | Durable operation ID + identity/argument digest protects **interactive Shell input** and every mutating exec/SFTP operation; same ID+different payload conflicts. |
| Q14 | **A** | EdgeSSH owns atomic admission/deduplication in **existing** durable storage before SSH dispatch; not an independent MCP receipt service/database/queue. |
| Q15 | **A** | Fixed low session concurrency, finite idle/absolute lifetimes and bounded output; reject overflow rather than queue. Numeric defaults remain Spec-level. |
| Q16 | **A** | Bounded UTF-8 text SFTP operations with explicit destructive/overwrite intent; no implicit binary transport and no claimed universal rename atomicity. |

### Boundary audit after Q11–Q16

- **Q6=B does not contradict Q11=A/Q12=A:** "persistent" means client-visible managed session across tool calls, **not** immortal TCP or detached jobs surviving Worker replacement. A background command may still outlive its initiating call while its owned connection stays alive.
- **Q13=A can be expensive if modeled per keystroke:** Protect input *batches/tool calls* with one durable admission each; do not silently exempt typing or character input, and do not create an additional input message broker. Batch size and serialization will be tested in the Spec.
- **Q14=A chooses ownership, not a particular database schema:** the EdgeSSH account already has a D1 host DB and SQLite-backed Durable Object session storage; a small additive durable receipt layout on EdgeSSH is the candidate. Do not duplicate facts as two competing sources of truth. A successful write to D1/DO is not a proof that SSH delivered the bytes.
- **Q15=A is essential to control cost and failure modes:** Cloudflare [TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) keep a DO resident for a *bounded protection period*, not indefinitely. Session status must state actual connection liveness, not imply it from persisted metadata.
- **Q16=A requires honest failure semantics:** a text overwrite that times out after part of a write may leave remote files modified; no "all-or-nothing" promise for generic SFTP. Require explicit intention and receipts.
- **Q2=B/Q4=B/Q8=A are unchanged:** the single dedicated EdgeSSH MCP token still enables unattended high-impact operations across all saved hosts. Prompt content, MCP tool safety annotations or an AI confirmation prompt are not additional server-side permissions.
- **No remote stop by stale PID:** only operations on a verifiably live and owned session/channel are eligible; a detached descendant may remain after stop. A secret/key rotation cannot retroactively undo completed remote effects.

## Round 4 — recorded operator decisions (2026-10-17)

| ID | Selected | Effective policy |
| --- | --- | --- |
| Q17 | **A** | Known-terminal receipts retained normally for 30 days; unresolved minimal non-replay markers retained until deliberate reconciliation. |
| Q18 | **A** | Inspect unknown remote effects before any new operation; no automatic retry or compensation, new intent uses a fresh operation ID. |
| Q19 | **A** | Durable admission unavailable ⇒ all new mutating commands/interactive input fail closed, with a narrow owner-authenticated best-effort live session stop exception. |
| Q20 | **A** | Rotated/revoked Bearer cannot authorize new calls; remote sessions are not guaranteed immediately killed, and live sessions still have finite lifetime. |
| Q21 | **Operator correction, not old A** | **EdgeSSH is an independently maintained fork and must not be changed.** Only the companion in `mcp-workers` may be developed/deployed. Old recommendation to add an EdgeSSH RPC first is withdrawn. |

### Q21 breaks the previous integration model

- **Q3=A:** only EdgeSSH decrypts credentials and executes SSH.
- **Q14=A:** only EdgeSSH atomically admits/stores MCP mutating-operation receipts.
- **Q21:** EdgeSSH cannot be changed, and currently provides neither a headless execute-only API nor an operation-receipt claim endpoint.

**No same-account Service Binding can fix missing method implementations.** The team must explicitly choose another SSH credential / execution / receipt custodian or suspend the prior full-featured MCP promise. This is a design incompatibility, not an implementation parameter.

## Final active frontier — Q22 (choose one coherent model)

**Q22 · How to provide a full SSH/SFTP MCP while EdgeSSH remains completely unchanged?**

- **A (recommended for isolation): Independent MCP host/credential configuration.** MCP manages its own SSH credentials and host list, entered or explicitly imported independently, and executes operations/receipts itself. No automatic EdgeSSH credential sync; EdgeSSH remains unaffected. Supersedes Q3=A and Q14=A, and requires restating how the original all-hosts Q4=B applies to onboarded MCP hosts. Reuse EdgeSSH Apache-2.0 SSH implementation where useful with attribution, not its browser WebSocket login/session APIs. **Operational trade-off:** separate credential maintenance.
- **B (possible, but higher secret exposure): Read the same existing EdgeSSH D1 and configure the same encryption key in the MCP Worker.** MCP reads/decrypts SSH credentials locally, executes commands itself, and stores its own authoritative receipts. The EdgeSSH fork remains unchanged and host credentials are automatically reusable, **but** Q3=A and Q14=A are explicitly revised; all remote SSH keys become accessible to the MCP Worker, and upstream schema changes can break it. No EdgeSSH D1 writes except separately reviewed adapter-owned receipt storage. Requires manual secret provisioning and compatibility/fingerprint tests. No authorization for live secret access yet.
- **C (retain old trust boundary):** Keep Q3=A/Q14=A unchanged and defer the executing SSH/SFTP MCP until EdgeSSH upstream exposes a supported internal execution service, or until requirements change. Do not claim a metadata-only MCP satisfies the already accepted Q2=B/Q6=B.

**Do not silently choose B just because an earlier user message wanted reuse of EdgeSSH SSH credentials; doing so would intentionally expand private-key custody. Do not silently choose A and promise EdgeSSH host sync that the system cannot provide.**

## Consistency gate after Q22

Update the old ADRs, authoritative receipt storage, ingress threat model, all-saved-host semantics, independent SSH engine/code-license strategy, fingerprint trust flow, and MCP-only deployment/rollback plan to align with the selected design. Then assess the remaining bounded numerical limits and actual Cloudflare constraints before seeking final operator approval and running `to-spec`.

## Preliminary acceptance risks / gates — no test result claimed

- Existing WebSSH/UI/login must function unchanged with integration disabled.
- An MCP caller cannot read SSH private keys, plaintext passwords, encryption keys or use credential-returning browser APIs.
- Invalid/missing distinct MCP Bearer and a missing Service Binding must fail closed on MCP, without disabling WebSSH.
- A bound Worker call must reach only explicitly exported internal methods, and target-side validation must re-check operation, host, port, and host-key identity.
- All saved hosts are discoverable and eligible (Q4=B), but trust and connection failure remain explicit; no fabricated online status.
- Arbitrary shell is mutating/high risk and cannot be labeled read-only.
- Timeouts/disconnects must not be reported as successful or definitely unexecuted when result is unknown.
- Repeated identical operation ID must never re-dispatch Shell input/SSH exec/SFTP writes; different arguments under same ID must conflict. Test concurrent claims, crash before dispatch, interrupted dispatch and repeated requests after restart.
- Lost sessions must not silently resurrect their SSH TCP connection, remote PTY, background job or stale PID ownership; UI remains operational when MCP is absent.
- Output must be bounded and distinguished from an operation's durable admission/side effects. No credentials, plaintext command or sensitive file payloads are written in receipt logs by default.
- Live SSH and SFTP mutations should be tested against owned disposable SSH fixtures, not production servers.
- API payload validation must guard result-size and argument-size limits, including malicious/untrusted tool output; Cloudflare Worker resource ceilings must be measured, not guessed.
- Source deployment of EdgeSSH and MCP Worker must stay independent. No release authorization is implied by this interview.

## Interview completion gate

Q17–Q21 are recorded, but **Q22 is a hard architecture blocker** introduced by the corrected source-ownership requirement. After Q22 is selected, revise contradictory earlier decisions and conduct a final security/no-overengineering audit before requesting final implementation-spec approval. The numerical session/transfer/time bounds and storage schema can be decided within the approved technical Spec, not by speculative extra features. No production code, deploy, secret change or SSH action is authorized during grilling.
