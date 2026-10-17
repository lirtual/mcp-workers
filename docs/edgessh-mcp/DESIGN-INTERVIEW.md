# EdgeSSH MCP — Grilling with Docs · Round 2

Status: **Round 1 operator decisions accepted; round 2 open; final design NOT APPROVED**.
Date: 2026-10-17
Source repos: [EdgeSSH](https://github.com/lirtual/EdgeSSH) and [mcp-workers](https://github.com/lirtual/mcp-workers).
Decision record: [ADR-0001](./adr/0001-edgessh-mcp-cross-repo-boundary.md).
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

## Candidate design honoring Q1–Q5 (implementation NOT approved)

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
  - bounded headless SSH connection or SFTP operation using existing SSH core
        |
        v
SSH server (privileges of stored SSH login account)
```

**Optional integration invariant:** EdgeSSH must remain fully operable when the MCP adapter is absent or its binding is not configured. The integration must not silently change browser routes, login or storage migration. No new public hostname, token-bypass HTTP route, credential-sharing database or Agent.

**Security truth:** The accepted feature set can modify or destroy remote state. A dedicated Bearer is an extremely powerful credential for the entire host collection; it is **not equivalent to per-operation human approval or a safety sandbox**. Model-generated commands must be treated as untrusted intentions and validated as structured inputs, not as authorized merely because the MCP caller is authenticated.

**Main implementation feasibility gate:** run a design/code-level proof that standalone noninteractive SSH exec and SFTP share the existing transport while not invoking a fake browser WebSocket. Pay particular attention to stdout/stderr, exit status, timeouts, close, disconnect and private-key memory lifetime. Reuse known working browser SSH and SFTP tests; don't rebuild the SSH protocol.

## Round 2 — independent frontier (awaits operator answers)

**Q6 · SSH command session lifetime**
- A (**recommended**): One `exec(command)` = one bounded noninteractive operation, no PTY, no persistent interactive Shell. Cap runtime/output and clean up connection at completion. A timeout does **not** prove the server rolled back side effects.
- B: Support persistent/interactive Shell and background processes from first release, with managed-session lifecycle, stop and recovery.

**Q7 · First-time host-key trust / changed fingerprint**
- A (**recommended**): MCP can execute only against a host fingerprint already verified by the human through EdgeSSH; unknown, missing or changed fingerprints fail closed until human re-confirms. This gate applies equally when Q4 grants eligibility to every host.
- B: MCP automatically trusts host fingerprints for initial connections or changes. This weakens server-identity protection.

**Q8 · Per-operation human confirmation**
- A (**minimum-complexity recommendation, high risk**): Possession of the dedicated EdgeSSH MCP Bearer authorizes unattended commands and SFTP changes on every saved host under the stored SSH login privileges, after input/target/host-key validation and finite limits; **no extra manual prompt on each call**. This raises the consequence of token compromise and prompt injection.
- B (**stronger security, more complexity**): Mutating commands and file operations need a separate, short-lived operator approval from EdgeSSH; requires pending operation state and approval UX. ChatGPT tool approval alone is not a reliable server-side guarantee.

**Q9 · Uncertain write/exec outcomes**
- A (**minimum-complexity recommendation**): No automatic retry of arbitrary SSH commands or SFTP mutations. On connection loss or timeout after possible dispatch, return an explicit **Unknown Outcome** and require human inspection/reconciliation before another attempt. Do not promise exactly-once behavior or silently treat it as failure; no new durable receipt service in v1.
- B: Build minimal persistent operation receipts and deduplication for mutating calls into the existing EdgeSSH storage from v1. This adds complexity but can protect against duplicate submissions, though cannot make arbitrary side effects transactional.

**Q10 · MCP-side SFTP transfer format**
- A (**recommended**): Include bounded text-oriented file read/write/create plus common list/rename/delete/mkdir operations. Exclude bulk binary upload/download and streaming from the first release; these remain available in the existing EdgeSSH browser File Manager. Limits must be appropriate for an MCP result, not automatically the browser's 64 MiB cap.
- B: Fully expose binary upload/download (up to existing SFTP transfer limits) with transport/chunking support in the first MCP release.

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

## Deferred frontier

Exact default time/output limits and concurrency (after Q6), possible approval UX (after Q8), status and deduplication schema (after Q9), file payload size and binary support (after Q10), independent deployment/rollback acceptance and compatibility between published EdgeSSH and the optional adapter.

When Q6–Q10 are resolved, update [CONTEXT.md](./CONTEXT.md) and the ADR, then run the last focused frontier of residual dependent questions. Only after the operator approves final consensus should `to-spec` or `to-tickets` begin. Do not implement or deploy during the interview.
