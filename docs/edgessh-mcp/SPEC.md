# EdgeSSH MCP — Technical Specification (v0.1)

> **Status:** Draft technical specification, synthesized by Matt Skills Curated / to-spec on 2026-10-17. Operator authorized **specification drafting**, NOT implementation, merging, secrets provisioning, production binding, deployment or any live SSH operation.
> **Target:** lirtual/mcp-workers, one new independent app at apps/ssh-mcp-worker (proposed Worker name: ssh-mcp-worker). Existing EdgeSSH fork and production deployment remain UNCHANGED.
> **Naming:** `ssh-mcp-worker` is the new Worker name, app directory and package identity; `EdgeSSH` remains the unchanged upstream credential/host-catalog product. Do not rename the EdgeSSH fork, its D1, or its current Worker.
> **Tracker:** [Issue #83 — EdgeSSH MCP v0.1 specification](https://github.com/lirtual/mcp-workers/issues/83), published through Matt Skills Curated / to-spec. `ready-for-agent` is a spec-review/decomposition label, not implementation authorization.
> **Authority:** [CONTEXT.md](./CONTEXT.md), [accepted Q1–Q22](./DESIGN-INTERVIEW.md), [ADR-0005](./adr/0005-independent-mcp-ssh-shared-edgessh-credentials.md), [final security audit](./FINAL-ARCHITECTURE-REVIEW.md).
> **Supersessions:** historical Q3=A (EdgeSSH-exclusive credential custody / SSH execution) and Q14=A (EdgeSSH-owned MCP receipts) are **expressly superseded by Q22=B**. Other agreed decisions remain intact.

## 1. Problem and success

The owner operates an independently maintained EdgeSSH fork that already stores up to 200 SSH hosts and encrypted login material in Cloudflare D1. They want an MCP companion usable from ChatGPT/Codex for host discovery, arbitrary one-shot SSH commands, bounded interactive managed Shell/background work and text SFTP changes, **without changing EdgeSSH or installing an Agent on target hosts**.

**Solution:** one additional independent Cloudflare MCP Worker in the existing monorepo. It consumes the current EdgeSSH D1 host catalog via fixed SELECTs, decrypts the requested saved record in memory using a **separately provisioned copy of the existing root ENCRYPTION_KEY**, and connects to the target through one Workers-compatible SSH engine. One SQLite-backed Durable Object (DO) *inside that same Worker* owns live managed SSH sessions, durable operation admission, duplicate detection, bounded output/status and cleanup. Reuse existing Portal Bearer validation and MCP infrastructure.

**Success criterion:** all tool surfaces and adverse-path tests in sections 6–12 pass against synthetic encrypted catalog data and owned disposable SSH fixtures. Real Portal integration and deployment require separate explicit approval. Do not claim first release complete by proving only a shell exec or only read-only metadata.

**Two consciously accepted residual risks (Q22=B):**
1. The copied EdgeSSH encryption root decrypts **all** compatible host records and also feeds GitHub login-flow/session cookie signing-key derivation when that auth mode is used.
2. A normal D1 Worker Binding is write-capable even if our source issues only SELECTs. "Read-only" is a **source-code promise**, not an enforced database principal permission.

Neither risk is eliminated by a clever wrapper, another Worker, or a renamed binding. Never claim otherwise.

## 2. User stories

1. **US01:** As an MCP user, I want to list my saved EdgeSSH hosts, so that I can choose targets without maintaining another inventory.
2. **US02:** As an MCP user, I want to inspect sanitized host details and trust readiness, so that I can tell why a host cannot be connected.
3. **US03:** As an MCP user, I want to execute an arbitrary bounded command on a selected saved host, so that I can perform remote administration from one tool call.
4. **US04:** As an MCP user, I want to see stdout, stderr, exit status and truncation separately, so that I can interpret command results without guessing.
5. **US05:** As an MCP user, I want to start a persistent interactive Shell, so that I can continue work across separate MCP calls.
6. **US06:** As an MCP user, I want to send bounded input to a session, so that I can operate an interactive program without opening a second session for each command.
7. **US07:** As an MCP user, I want to poll session output and connection state, so that I can monitor a long-running session-owned job.
8. **US08:** As an MCP user, I want to stop my live session or its owned channel, so that I can release resources and terminate controllable work.
9. **US09:** As an MCP user, I want lost sessions to be reported as lost, so that a network failure never silently replays my earlier input.
10. **US10:** As an MCP user, I want to list a remote directory and read bounded UTF-8 text files, so that I can inspect configurations without binary transfer.
11. **US11:** As an MCP user, I want to create and explicitly overwrite small text files, so that I can make targeted remote configuration edits.
12. **US12:** As an MCP user, I want to rename, delete and create remote files/directories with explicit intent, so that I can perform ordinary SFTP maintenance.
13. **US13:** As an MCP user, I want to reuse a stable operation ID safely, so that a duplicate delivery does not execute the same effect twice.
14. **US14:** As an MCP user, I want changed parameters under a reused operation ID rejected, so that different intentions cannot share a receipt.
15. **US15:** As an MCP user, I want to look up an operation's durable status, so that I can reconcile interrupted commands or writes.
16. **US16:** As an MCP user, I want unknown outcomes preserved without automatic retry, so that a temporary failure does not repeat destructive work.
17. **US17:** As an MCP user, I want an unverified or changed SSH server identity rejected before authentication, so that my credentials are not sent to an impostor.
18. **US18:** As an MCP user, I want only saved reachable public SSH hosts accepted, so that the tools cannot become an arbitrary network proxy.
19. **US19:** As an MCP user, I want an error for an unreachable, deleted, malformed or outdated saved host, so that failed lookups never produce guessed results.
20. **US20:** As an MCP user, I want the system to reject work when resources or receipt storage are unavailable, so that safety guarantees are not silently weakened.
21. **US21:** As an authorized MCP user, I want to attempt stopping a provably owned live session despite a receipt-store fault, so that a storage incident does not trap active resources.
22. **US22:** As an operator, I want old MCP Bearer credentials rejected after rotation, so that I can revoke new tool access without a global process-kill platform.
23. **US23:** As an operator, I want short-lived connections for one-shot operations and automatic idle session cleanup, so that casual MCP use does not leave an Agent or permanent SSH connection running.
24. **US24:** As an operator, I want the original EdgeSSH Worker, schema, secret and WebSSH/SFTP UI unchanged, so that upstream maintenance stays independent.
25. **US25:** As an operator, I want an independently disableable and rollback-safe MCP deployment, so that a failed upgrade does not erase unresolved receipts or impact EdgeSSH.
26. **US26:** As an operator, I want errors, logs and receipts free of stored connection secrets, so that operating the companion does not automatically disclose credential material.
27. **US27:** As an operator, I want a test-first SSH/PTY/SFTP compatibility gate, so that unsupported Workers libraries cannot trigger speculative infrastructure expansion.

## 3. Scope, invariants and architecture

### 3.1 Fixed Q1–Q22 decisions

- Same Cloudflare account (Q1=A); first release includes arbitrary SSH commands, SFTP mutations and interactive sessions/live session-owned background work (Q2=B, Q6=B); all Saved Hosts eligible without per-host opt-in (Q4=B); dedicated, unique Portal Bearer (Q5=A).
- Previously verified host-key fingerprint mandatory; no unattended first-seen/changed-key trust (Q7=A). Authorized requests are unattended, with no EdgeSSH human approval on every mutation (Q8=A).
- Durable receipts, no blind replay, receipts on *interactive input* (Q9=B/Q13=A). Bounded text SFTP (Q10=A/Q16=A).
- Live sessions can cross MCP calls, not a DO eviction/deploy/disconnect (Q11=A), and only currently provable session-owned jobs are controllable (Q12=A).
- **Q22=B overrides Q3 and Q14 only:** MCP is a second credential custodian, SSH executor and authoritative **MCP-side** receipt store; EdgeSSH remains the only saved-host catalog writer.
- Finite session/output limits (Q15=A); 30-day normal terminal receipt retention plus protected unknown markers (Q17=A); manual reconciliation/no auto-retry (Q18=A); fail-closed writes on store fault with narrow authenticated live stop exception (Q19=A); token rotation denies new tool calls without instant fleet kill (Q20=A); **NO EdgeSSH modifications** (Q21).

### 3.2 Components and ownership

| Component | Responsibilities | Forbidden responsibility |
| --- | --- | --- |
| apps/ssh-mcp-worker MCP fetch entry | /mcp ingress, dedicated Portal Bearer, tool discovery, input validation, safe error mapping | SSH credentials in tool output, unauthenticated alternative routes |
| Application-local HostReader | Parameterized SELECT from existing EdgeSSH D1; workspace account ID; AES-GCM v1 decode; sanitized host view | INSERT/UPDATE/DELETE/DDL to EdgeSSH D1; caching/syncing a second host catalog |
| Application-local SSH engine | One verified outbound transport; authentication, one-shot exec, PTY/channel operations and text SFTP | Login via EdgeSSH browser cookies; arbitrary raw TCP host supplied by client; a second duplicate SSH implementation |
| One MCP-owned SQLite-backed DO namespace/class | Single-admin session registry; atomic operation-ID claim; persistent receipt status; bounded output/idle cleanup; session-owned SSH sockets | Extra standalone Worker, queue, new D1 receipt database, remote Agent or guarantee that a PID can be reattached after loss |
| Existing EdgeSSH Worker + D1 | Unmodified source of saved hosts / independent browser application | New MCP RPC, EdgeSSH database migrations, secret rotation or production changes in this project |
| Existing packages/portal-auth | Bearer comparison and Origin check per established repository pattern | User tenancy, OAuth service, separate RBAC or per-host consent |

**Minimal DO identity:** one deterministic, application-private DO instance for this single-administrator workspace. It serializes receipt admissions and manages the small finite live-session set. Reuse the SQLite storage inside this DO; no extra receipt persistence engine. Store no root encryption key or saved SSH private key in durable receipt rows.

**Connection ownership:** all state-changing SSH/SFTP work is dispatched from the same DO authority that durably admits its operation ID. The ingress must not authenticate once and then let a second unguarded Worker handler execute effects. Read-only host metadata can return from the stateless Worker without creating an SSH connection or long-running instance.

**Existing backend boundary:** authenticate the caller at /mcp before any host lookup or DO call. Pass only validated requests and nonsecret caller context into the DO; never forward the raw Portal bearer into another component unnecessarily. Every new call, including status and emergency stop, rechecks authentication.

### 3.3 Credential/source contract (verified from current EdgeSSH source)

- Existing D1 hosts table: id, account_id, encrypted_payload, updated_at. Existing workspace_state record (id=1) supplies canonical account_id. Read exactly the active workspace's records; fail closed on missing/ambiguous workspace, mismatched account, deleted row, invalid UUID or inconsistent host fields.
- Encrypted record format is v1.Base64(12-byte IV).Base64(AES-GCM ciphertext+tag); root ENCRYPTION_KEY must Base64-decode to **32 bytes**; AAD UTF-8 is **edgessh:v1:{accountId}:{hostId}**. Decode strictly. Wrong key/account/host, tampering, unsupported version or bad encoding returns no plaintext and no SSH attempt.
- Host payload: host, port, username, authMethod(password|publickey), password/privateKey, fingerprint, name/group, initialCommand, encoding and optional cached system/location. Only necessary fields are projected into results; NEVER output the saved password, private key or raw host payload.
- **Do not auto-run initialCommand.** It is a saved browser-session preference, not permission for unattended MCP execution.
- Every *new* SSH connection and mutation (including `ssh_session_input` on an already-open session) re-reads the current saved row. A change in encrypted data may occur without updated_at changing; do not treat updated_at alone as a trustworthy identity/credential version. For already-live sessions, continue using the initially verified SSH transport; do not silently migrate credentials, target or host-key to another server. If host disappears or its security-relevant target/pin changes, deny new input and close the owned session best-effort rather than reattach.
- Cloudflare D1 binding must point to the **same existing database**; its general D1 API remains write-capable. Implement only literal, fixed, bound SELECT queries. No generic SQL tool, input-driven SQL construction, migrations, admin statements, or data writes. At code review, static grep/allowlist of HostReader query templates is required. Do not describe this as database-enforced read-only.
- Root ENCRYPTION_KEY is provisioned as an MCP-only Cloudflare Secret by the operator **later** and must never be printed, logged, derived into another publicly callable credential, stored in DO SQLite, or returned by a tool. No credential material is provisioned during spec or tickets.

### 3.4 Host-key trust and target validation

- Derive destination only from a fresh saved host ID record. Validate host/port/username/auth method against the existing EdgeSSH input constraints. Enforce no TCP port 25 and forbid private/reserved/loopback/link-local/metadata targets and malicious DNS rebinding, following or strengthening EdgeSSH's existing target-publicness checks.
- Resolve once per connection admission into bounded candidate IP addresses, reject **any** disallowed candidates and connect only to a checked numeric address; avoid a second unchecked hostname resolution between validation and connect. Validate IPv4, IPv6, mapped addresses, IDNA and DNS changes.
- SSH KEX verifies cryptographic host-key signature and compares actual fingerprint to the **nonempty** human-pinned SHA256 fingerprint in the decrypted EdgeSSH host record, **before** sending password/private-key authentication data. Empty, unrecognized or changed pins fail closed. Never call an EdgeSSH browser approval endpoint or write back a new pin.
- A host can be eligible and listed while blocked from execution. Return a machine-readable readiness reason without leaking credentials; no fabricated host online/verified status.

## 4. MCP tool contract (version 1)

Tool names are proposed contract names for the new app only; they do not rename existing MCP tools. All tools use input schemas and bounded output. The single-stable operation_id (canonical UUID string) is generated by the client once per intended mutation; status/read-only tools do not need it. No binary payload, raw TCP tunnel, arbitrary SQL or credential export tools.

| Tool | Inputs (required unless optional) | Return / effect |
| --- | --- | --- |
| list_hosts | optional cursor, limit | Page of sanitized id/name/group/host/port/username/authMethod/trust-readiness; no secrets; all hosts eligible |
| get_host | host_id | Sanitized one-host details and trust readiness; may return not found |
| ssh_exec | host_id, command, operation_id, optional timeout_ms | One non-PTY command, bounded stdout/stderr, exit_code if observed, status/receipt; close SSH after terminal response |
| ssh_session_start | host_id, operation_id, optional term_type | New interactive PTY/live SSH session, session_id, status/receipt; can outlive this MCP call |
| ssh_session_input | session_id, operation_id, input | One serialized bounded PTY input batch, admission/receipt and delivery certainty; repeated ID never resends bytes |
| ssh_session_output | session_id, optional offset/limit | Bounded output since cursor; truncation/loss explicitly flagged, no side effect |
| ssh_session_status | session_id | live/closing/closed/lost, timestamps, bounded output cursor, explicit uncertain effects |
| ssh_session_stop | session_id, operation_id | Owner-scoped best-effort SSH channel/session close, verified authority, honest stop outcome |
| sftp_list | host_id, path | Bounded directory entries with truncation indicator |
| sftp_read_text | host_id, path | UTF-8 text with bytes/cursor/truncation indicators; refuse non-UTF-8/binary/oversized content |
| sftp_write_text | host_id, path, text, overwrite:boolean, operation_id | Create or explicit overwrite; existence conflict if overwrite=false; report possible partial writes |
| sftp_rename | host_id, old_path, new_path, overwrite:boolean, operation_id | Explicit rename intention; no assumption of universally atomic rename semantics |
| sftp_delete | host_id, path, kind:file|empty_directory, confirm:true, operation_id | Explicit deletion, no recursive delete |
| sftp_mkdir | host_id, path, operation_id | One directory create; no recursive tree operation |
| get_operation_status | operation_id | Durable admission/outcome identity, last known status, no original command or file contents |

**Output safety:** command stdout/stderr and SFTP file contents are inherently untrusted remote data and may include secrets from that host. This app cannot guarantee their redaction. Do not additionally expose the *stored SSH connection password/private key/root encryption key* in metadata, errors, receipts, observability or tool schemas. Result output must clearly distinguish tool facts from remote text.

**Errors:** use stable codes: unauthorized, auth_misconfigured, host_not_found, host_untrusted, host_unreachable, host_record_invalid, unsupported_crypto_version, secret_mismatch, invalid_target, invalid_args, capacity_reached, session_not_found, session_lost, receipt_conflict, receipt_store_unavailable, unknown_outcome, output_truncated, unsupported_ssh_runtime. Avoid raw D1/SSH exceptions containing credential data.

## 5. Proposed bounded defaults (spec choices, not claimed prior operator decisions)

These are adjustable acceptance defaults, not reasons to build a policy engine or long-running service. If the chosen SSH runtime cannot meet them in a test fixture, revise this spec in review rather than silently weakening guarantees.

| Bound | v0.1 proposed default / maximum |
| --- | --- |
| Max active managed SSH sessions | 2 per saved host, **4 total** for this single-admin MCP |
| Managed session idle deadline | **10 min** since last authorized input/activity; output polling alone does not extend it |
| Managed session absolute lifetime | **60 min** maximum even if active; runtime may end earlier |
| One-shot exec wall-clock deadline | default **30 s**, maximum **60 s** (longer jobs use managed sessions) |
| Initial TCP/SSH connect deadline | **10 s** |
| Output ring in a live session | **256 KiB** of trailing bytes; eviction of older output marked as truncated |
| Per MCP result output | **64 KiB** aggregate maximum, including stdout/stderr/text/metadata |
| Interactive input per call | **16 KiB** UTF-8 input (count encoded bytes, not characters) |
| One-shot SSH command input | **16 KiB** maximum UTF-8 bytes; reject over-limit before admission |
| SFTP path input | **4 KiB** maximum UTF-8 bytes per path; reject over-limit before admission |
| One SFTP text read or write | **64 KiB** maximum bytes; reject over-limit content rather than silently mutating partially |
| Directory listing | maximum **100 entries** returned per request (cursor or explicit truncation) |
| Host catalog listing | default **50** per page; maximum **200** distinct records as permitted by the current EdgeSSH app |
| Normal terminal receipt retention | **30 days** from original admission, eligible for bounded cleanup |
| Unknown or ambiguous in-flight receipt | preserve minimal non-replay guard **until deliberate reconciliation**, no automatic age expiry |
| Background tasks | must remain attached to a demonstrably live managed SSH channel/session, no detached process supervision |

Important: "60 min" is an **absolute business deadline**, not a runtime guarantee that Cloudflare will keep a TCP socket alive for 60 minutes. The [DO lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/) and [TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) may terminate availability earlier. Use DO alarms/on-request checks to enforce cleanup; do not introduce periodic Cron just for sweeping sessions. A one-shot call never leaves an idle SSH transport behind on success/failure/timeout. Host-list requests open **zero** SSH connections.

## 6. Durable operation receipt and session contracts

### 6.1 Receipt authority and deduplication

- **Only the MCP-owned DO** atomically admits effectful operations, then dispatches SSH/SFTP effects after the durable write resolves. Operation IDs have a unique constraint across this single admin; hash a canonical tuple of tool name, saved host ID, current session ID when applicable and normalized effectful arguments. Do not hash timestamps, bearer tokens or random fields not part of the operation intention.
- On first admission, write operation ID, argument digest, tool category, associated host/session ID, state, created/updated timestamps and optional reason/exit status. On same ID+digest, return the **existing state/result metadata only**, NEVER dispatch the effect again. On same ID+different digest, fail with receipt_conflict without dispatch.
- **Every** potential mutation is covered: exec, session start, each interactive input *batch* (not an unbounded keystroke stream), session stop during normal storage health, SFTP write, rename, delete and mkdir. Reads/status/list tools are effect-free in the MCP contract and require no receipt.
- Persist an admission marker **before** opening a connection or handing the input to a live SSH channel. An initial fail-to-write is definitive no-dispatch; if the admitted operation is interrupted or terminal outcome cannot be persisted, conservatively record/return unknown rather than try the SSH effect again.
- A durable record is **not** an atomic transaction across the remote SSH server; completion/failure statuses reflect observable outcomes, **not proof of absence of side effects** after a failed command/partial write. Nonzero exit code is still a completed observed command with nonzero exit, not "definitely unexecuted."
- Minimum lifecycle: admitted, running, completed, failed, unknown. Use an explicit dispatch/effect-certainty field or equivalent documented semantics to distinguish definitively rejected-before-dispatch from post-dispatch SSH errors.
- Routine read of status must not reissue effects. If the DO restarts with admitted/running records but no live SSH channel, mark them unknown/needs-reconciliation conservatively. **No automatic execution or queue retries.**

### 6.2 Retention and reconciliation

- Ordinary known-terminal receipts have a **30-day** normal retention period from admission; bounded opportunistic cleanup on ordinary operations/DO alarm, not a separate scheduler.
- **Deduplication horizon:** once a known-terminal receipt is legitimately cleaned up after 30 days, the service no longer has evidence to recognize its old ID; never claim indefinite non-replay for such IDs. Clients must generate a fresh UUID for each new intention and not retry expired IDs. Unknown/unproven-effect tombstones are different: retain them across cleanup until deliberate reconciliation, with no re-dispatch of those IDs.
- For unknown, interrupted, unproven-effect and ambiguous statuses, keep **minimal tombstones** (operation ID, tool/host/session identity, digest, unresolved state, timestamps) past 30 days until authenticated deliberate owner-led reconciliation. Do not store plaintext command/input/file contents in receipts.
- A human/operator inspects remote state using new *read* requests, then deliberately chooses any new mutation with a **fresh operation_id**. Acknowledgement of the old unknown does not make its ID re-executable. No automated compensation or blind retry.
- If the receipt store is unavailable or at capacity, **fail closed** for new mutating work, including interactive input and session creation. Continue available safe reads and authorized status checks where possible.
- **Emergency exception:** a properly authenticated stop of a *provably live and currently session-owned* channel can be attempted when persistence is unavailable; it cannot run arbitrary commands, write files, accept input or signal a PID inferred from stale history. Clearly label any unrecordable stop result as unverified/unknown.

### 6.3 Live session contract

- Start returns a stable session ID and a fresh live SSH channel; only a still-live session permits input/status/stop. DO tracks active channel ownership in memory while alive, and keeps persistent limited metadata/status only. An unrelated or unknown session_id must never acquire channel privileges.
- Session input is serialized per session, ordered exactly as admitted. Response distinguishes durable admission, SSH write accepted, any known terminal status; bytes delivered ambiguously **must not** be replayed after reconnect. Retain bounded session output and output cursor/truncation state; never retain an unbounded terminal history.
- When HTTP request finishes, a managed Shell may remain live until idle deadline, absolute deadline, an explicit stop, remote close, DO eviction/runtime update or connectivity failure. Closing a session/socket is not a promise that a detached remote child process was reaped.
- After lost TCP/session, preserve session identity and last-known bounded status, mark **lost**, reject input and any attempt to revive a stale PTY or arbitrary PID. Requesting a new session is a separate, newly authorized operation with a new identity.
- On idle or absolute deadline, attempt live session close and release SSH/TCP promptly; a DO alarm/on-request cleanup rechecks deadlines. Never promise indefinite background execution or keep an idle SSH connection alive just because a receipt exists.
- No remote Agent, systemd service, PID resurrection, automatic shell recreation, distributed cron, process tree supervisor or always-on Cloudflare instance.

## 7. Application source layout / change surface

Use existing app/CI patterns; this is a contract, not a mandated file-for-file implementation. Proposed boundaries:

| Location | Responsibility |
| --- | --- |
| apps/ssh-mcp-worker/src/index.ts | /mcp HTTP route, authentication via packages/portal-auth, stateless MCP SDK handler, safe error boundary |
| apps/ssh-mcp-worker/src/tools.ts (or local equivalent) | Tool definitions, validated inputs/outputs, DO access |
| apps/ssh-mcp-worker/src/hosts.ts | Fixed D1 SELECT catalog access, account/host pin, AES-GCM v1 decode, sanitized projection |
| apps/ssh-mcp-worker/src/ssh/ | Exactly one chosen Workers-compatible SSH protocol implementation/adapter, including PTY and SFTP text |
| apps/ssh-mcp-worker/src/session-do.ts | One SQLite DO for durable receipt admission, live session/channel registry, bounded outputs, cleanup |
| apps/ssh-mcp-worker/src/types.ts | Tight Env binding types; no credential-bearing public type in MCP schemas |
| apps/ssh-mcp-worker/wrangler.jsonc | Distinct Worker, binding to existing EdgeSSH D1, DO migration for **new MCP namespace only**, required secrets MCP_ACCESS_TOKEN and copied ENCRYPTION_KEY |
| apps/ssh-mcp-worker/tests/ | Public /mcp + DO boundary and disposable SSH-fixture tests using existing repo approach |
| docs/edgessh-mcp/ | This spec, ADRs, final audit, setup/rollback guidance |

**Do not** modify: EdgeSSH repo, its wrangler/deployed Worker, existing EdgeSSH D1 schema/content, EdgeSSH root key, other MCP apps, shared portal-auth semantics, existing production workers, CI infrastructure without a proven need. Reuse existing pnpm workspace, available scripts/checks, and independent Worker deployment conventions.

## 8. External acceptance seams / test decisions

**Highest-value seam:** real MCP /mcp handler with Bearer, real SQLite-backed DO and a disposable fake/owned SSH endpoint under a Workers-compatible test runtime. Favor black-box tool behavior, avoid mocking every crypto/transport/channel helper. A small synthetic D1 hosts/workspace fixture is appropriate. Separate genuine network integration from offline pure crypto fixtures.

### Gate G0 — independent runtime/SSH feasibility, BEFORE feature implementation

- Prove selected *single* SSH implementation loads/bundles in the target workerd runtime and does **not** fail on module-init WASM or unsupported Node APIs; then exercise signed host key KEX, password and private-key auth, one-shot stdout/stderr/exit, interactive PTY input/output/stop, and text SFTP listing/read/write on disposable fixtures.
- Inspect license/attribution if adapting EdgeSSH Apache-2.0 modules. Avoid bundling browser auth/UI and avoid shipping two SSH engines.
- If one feasible implementation cannot support these contracted capabilities, **stop and report the gap** for renewed design review; do not silently replace Q6=B with one-shot-only, introduce remote Agent, plaintext browser credentials API or bypass host-key verification.
- Record exact SSH test fixture/runtime version, supported algorithms and known limitations; do not claim success until actual tests pass.

### Gate G1 — encrypted host catalog (offline)

- Synthetic deterministic AES-GCM v1 fixtures: correct account ID+host ID decrypts, wrong key/AAD/host or altered ciphertext rejects, unsupported version rejects, missing workspace rejects.
- All Saved Hosts list with sanitized metadata, no credential fields; pagination up to EdgeSSH current max; host deletion/change reflected on next operation even when updated_at is unchanged.
- Assert no EdgeSSH D1 write statements/migrations/DDL are issued; read-only is application policy, **not** database permission isolation.

### Gate G2 — security boundary

- Missing/bad/rotated Bearer or invalid Origin denies all tools including status/stop. Missing encryption secret or D1 binding fails closed without returning secrets; no open /debug, /admin, /api/credentials or raw TCP endpoint.
- Missing/changed fingerprint and forged host key reject **before password/private-key authentication**; captured fixture proves no auth bytes emitted.
- Private/reserved IPv4/IPv6, DNS rebinding, metadata address, unapproved port and arbitrary caller host are rejected. InitialCommand is never auto-executed.
- Logs and thrown error paths contain no saved SSH login credentials, root key, decrypted host object or raw SQL rows. Remote command output is untrusted and may contain other secrets; don't falsely assert all such output is redacted.

### Gate G3 — receipt exactly-once *admission*, not exactly-once effects

- Two concurrent same-ID requests with same digest produce exactly one SSH dispatch. Same ID/different digest yields conflict. Dedup holds after DO restart/Worker rollback.
- After durable claim but before dispatch, and after dispatch but before response/receipt update, injected restart/failure returns admitted/unknown conservatively; never auto-reexecutes.
- Interactive input batches are serialized and deduped even under concurrent client retries; mixed ordering cannot cause duplicated writes.
- Store unavailable: reject new effectful requests before SSH side effects; authorized stop of a provably owned live channel still works best-effort; invalid caller or stale session cannot use emergency stop.
- Terminal 30-day retention, unknown indefinite minimal tombstone and deliberate reconciliation preserve non-replay identity across restarts. No full original command or file payload stored.

### Gate G4 — bounded runtime/lifecycle and SFTP

- Host listing/metadata does not open SSH or keep DO running; one-shot exec/SFTP closes SSH on success, failure and timeout.
- Managed session across multiple MCP requests; idle timeout, absolute lifetime, output truncation, cap at 2/host and 4 total; DO eviction/deploy or SSH disconnect produces truthful lost status without replay or PID kill.
- Remote process detached outside current owned SSH session is not claimed controllable; abnormal close does not invent a successful termination.
- SFTP UTF-8 validation, fixed 64 KiB bound, explicit overwrite/delete, same-ID duplicate suppression, partial-write unknown semantics; no binary streaming, recursive deletion or implicit overwrite.
- A restart/rotation of the MCP Bearer rejects old token on every *new* call, but does not claim live remote processes were instantly stopped.
- Use the exact configured version and actual Cloudflare free-plan constraints for performance/cost checks; don't turn an estimated 15-minute DO keep-alive protection into a guaranteed SSH session lifetime.

### Gate G5 — integration, release and rollback (separate future authorization)

- Document how to create a new MCP-only Worker/DO namespace and connect **the already existing** EdgeSSH D1 by its actually discovered ID (do not guess IDs or embed them in spec), provision independent secrets with human control and keep EdgeSSH version/config unchanged.
- Test independent /mcp Portal authentication end-to-end with real client flow and an owned safe SSH fixture; direct URL success alone is insufficient.
- MCP-only deploy/disable/rollback retains receipt IDs/unknown markers. If older code cannot parse newer receipt schema, fail closed rather than migrating backward/deleting receipts.
- Validate live environment configuration without displaying stored root key or live SSH credentials; no test against a production SSH server before explicit operator authorization.
- Final negative regression: WebSSH and SFTP continue unaffected when MCP is unconfigured, disabled, rolled back or broken.

## 9. Failure, release and observability policies

**Error response format:** status / safe error_code / short nonsecret message / operation_id when applicable / unknown-outcome flag. Never echo command, PTY input, file payload, decrypted credential or root key in errors or logs. Attach bounded in-memory output **only** on authorized result-polling paths; receipt rows persist only minimal status/identity, not remote content.

**Observability:** existing Cloudflare Worker logs of request class, sanitized host ID/operation ID, duration band, status and error code; avoid command contents, raw host addresses, auth header, file paths where sensitive, plaintext stdout/stderr and any encryption material. Use existing CI workflow if it covers the new app, otherwise use app-local checks; do not create new CI absent an explicit dependency.

**Independent release:** new Worker is disabled/unconfigured by default, no secret or D1 binding provisioned in this document; operator later approves a staged release using synthetic data and disposable SSH target. Only after all G0–G5 gates and separately authorized production cutover can a Portal registration / live host test proceed. The EdgeSSH fork stays untouched throughout. Keep PR #81 Draft through current specification phase.

**Rollback:** disable MCP ingress or roll back **only its own source/deployment**. Never revert/erase the shared EdgeSSH D1 or its encryption root. Preserve DO receipts and unknown tombstones across updates; do not silently create a new DO identity on rollback. A fresh workspace after loss of receipts must not accept old operation IDs as if no effects happened; require deliberate recovery or operator reset procedure.

## 10. Explicitly out of scope

- Any source, worker, config, D1 schema, stored host data, login or secret mutation in the independently maintained EdgeSSH fork.
- A remote Linux Agent, permanent target daemon/systemd user service, background cloud VM, process-ID supervisor or automatic reattach to lost SSH sessions.
- A second deployed Worker, host-catalog sync/cache DB, separate receipt D1 database, R2/Queues/Workflows job system, CRON scan, generic scheduler or new tracing platform.
- A shared credential-broker HTTP service, EdgeSSH browser cookie/session automation, plaintext /api/hosts/:id/credentials as MCP tool, generic SQL or raw TCP proxy, arbitrary host not stored in EdgeSSH.
- First-seen/change host-key auto-trust, skipping SSH signature validation, private IP tunneling, port forwarding, binary file upload/download, resumable transfers, recursive delete/chmod/chown.
- Per-host opt-in/RBAC, a fresh OAuth provider, routine per-command human approval, multi-tenant collaboration and unlimited concurrency.
- Blind retries/automatic compensation of uncertain remote mutations, exactly-once remote effect guarantees, unlimited historical Shell output or permanent session uptime.
- Replacing the accepted first-release SSH/SFTP/interactive capability with a metadata-only or one-shot-only MCP solely to make implementation easier.
- Production secret provisioning, Cloudflare deployment, real production DB queries, live SSH changes and Portal integration in this spec-only operation.

## 11. Deliverable and handoff

**Deliverable:** this Draft Spec plus prior domain/ADR/review material in PR #81, **not code**. Planning tickets [#84–#95](https://github.com/lirtual/mcp-workers/issues/84) were subsequently published under [Issue #83](https://github.com/lirtual/mcp-workers/issues/83). Their existence does **not** authorize implementation, real secrets/D1/SSH access, merge, or deployment.

**Dependencies/ordering for published tickets:** G0 runtime feasibility first; then G1 host/crypto + G2 security; then G3 DO receipts & managed sessions; then G4 full SSH/SFTP tools + bound/lifecycle; lastly G5 staging/rollback. Security must be tested through the real outer MCP/DO/SSH seams, not only mocked helpers.

**Decision audit:** no original Q1–Q22 product decision was changed in the Spec. The numerical defaults and module paths in section 5/7 are **new proposed engineering defaults**, explicitly marked for spec review; they are not falsely attributed to operator selections. Any failed hard feasibility gate requires spec revision rather than silent scope reductions.
