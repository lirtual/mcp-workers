# Remote Control MCP — v1 Technical Specification

> **Status:** Spec synthesized using Matt Skills Curated `to-spec`, 2026-10-12, tracked in [GitHub spec Issue #2](https://github.com/lirtual/mcp-workers/issues/2). **Native Node.js Agent execution-engine change accepted in ADR-0013; T01 already delivered, further implementation and deployment remain separately gated.**
>
> **Scope of authority:** This spec consolidates previously accepted decisions, especially [CONTEXT](./CONTEXT.md), [ADR-0011](./adr/0011-direct-linux-user-no-path-allowlist.md) (no container/path allowlist, existing Linux user), [ADR-0012](./adr/0012-reuse-portal-bearer-auth-with-independent-secret.md) (Portal static Bearer with a separate token value) and [ADR-0013](./adr/0013-native-nodejs-linux-agent.md) (native Node.js execution; no Desktop Commander runtime). Superseded OAuth and container ADRs are historical only. [Research notes](./RESEARCH-DRAFT.md) and [earlier draft](./SPEC-DRAFT.md) are reference material, **not competing current specs**.
>
> **Implementation gate:** The selected Portal-to-ChatGPT static Bearer route has not been proved end to end. This fact is an **explicit blocker**, not an invitation to silently change authentication. Shell and file mutation cannot be enabled until the acceptance gates below pass.

## 1. Problem, outcome, and constraints

### Problem

A single owner wants to inspect and change files, search projects, run developer commands and manage owned long-running sessions on one remote Linux host through an MCP client, without maintaining a third-party relay or a broad new infrastructure stack. The previous design accumulated undesired Docker isolation, project-root restrictions and GitHub OAuth setup.

### Solution

A single Cloudflare MCP Worker validates a **Remote Control-specific** Portal-supplied static Bearer token and relays approved tool requests over a **fixed Workers VPC Service** and **private outbound Tunnel** to a thin Linux Agent. The Agent validates its separate device credential and implements file/search/Shell tools using **Node.js built-ins**. It owns bounded local operation/session records, without a Desktop Commander subprocess or a second MCP transport.

The Agent runs as the owner's **existing ordinary Linux login user**. There is no container, new service account, application directory allowlist, GUI control or native Windows backend. WSL2 Linux is an optional deployment environment, not a product dependency.

### Non-negotiable invariants

1. Only **one authorized Linux device/host** is reachable from the Worker; no client-selected address, port or arbitrary HTTP proxy.
2. The device listener is **not publicly published**. VPC Service, not broad VPC Network, is the Worker's route.
3. The public MCP endpoint **fails closed** on missing/wrong `MCP_ACCESS_TOKEN`; this Worker uses the existing secret **name but a different value** from Database/IMA/Raindrop. There is no anonymous tool fallback or OAuth in v1.
4. Worker's Portal bearer never reaches the Agent. Worker-to-Agent authentication uses a separately provisioned credential.
5. The local authority is the **existing non-root Linux user's real OS permissions**. No claim of sandboxing or effective denial of sudo/host-admin operations from an allowlist if the account can already perform them.
6. Only a **curated, explicitly implemented set** of MCP tools is exposed; the Worker and Agent validate the same public argument contracts. No third-party tool engine or unreviewed functionality is implicitly exposed.
7. Every mutation has a stable operation identity and a **durable local receipt before dispatch**. Ambiguous effects must not be blindly replayed; no exactly-once execution claim.
8. Long-running sessions have Agent-owned identity; actions never intentionally target unrelated host processes.
9. No feature code, cloud resources, runtime secrets or deployment is authorized by publication of this document.

## 2. User stories

All stories represent v1 paths and should be reflected in the acceptance matrix.

1. **As an owner, I want to connect using my existing MCP Portal setup, so that I can access my Linux machine without configuring another login service.**
2. **As an owner, I want invalid connections to be rejected, so that another person cannot use my machine remotely.**
3. **As an owner, I want to know when my device is offline, so that I do not mistake a connectivity failure for a completed task.**
4. **As an owner, I want to list folders and inspect file information, so that I can explore the files my account can access.**
5. **As an owner, I want to read files in manageable portions, so that large files do not overwhelm the conversation.**
6. **As an owner, I want to search names and file contents, so that I can find code across my Linux files.**
7. **As an owner, I want to create, edit, append, rename and move files, so that I can maintain projects remotely.**
8. **As an owner, I want to run a development command, so that I can build, test or troubleshoot software when away from my computer.**
9. **As an owner, I want to start a development server and return later, so that it can continue beyond the original request.**
10. **As an owner, I want to inspect the state and recent output of my started processes, so that I can tell whether they are working.**
11. **As an owner, I want to send input to or stop a process I started, so that I can manage an interactive session without affecting unrelated processes.**
12. **As an owner, I want to check the outcome of an interrupted edit or command, so that I do not accidentally execute it twice.**
13. **As an owner, I want uncertain results labeled clearly after a disconnect or restart, so that I can decide whether a manual retry is safe.**
14. **As an owner, I want a stolen credential to be replaceable, so that I can revoke remote access without replacing credentials for my other MCP services.**
15. **As an owner, I want the assistant's remote capabilities limited to the advertised tool categories, so that irrelevant upstream configuration and host-process tools are not available.**
16. **As an owner, I want to understand the reach of my ordinary Linux account, so that I knowingly accept the risks of unattended Shell commands.**
17. **As an owner, I want private files and tool credentials excluded from infrastructure logs as far as supported, so that troubleshooting does not needlessly leak secrets.**
18. **As a maintainer, I want to validate the actual client and private network route with a harmless read-only operation first, so that unsafe features are not enabled on an unverified connection.**

## 3. Boundaries and architecture

| Component | Responsibilities | Exclusions |
| --- | --- | --- |
| `apps/remote-control-mcp-worker` (new) | MCP HTTP `/mcp`, Portal Bearer verification, curated tool definitions, argument shape/bounds, request-to-device forwarding, safe errors | OAuth/consent, custom remote Shell engine, arbitrary fetch proxy, durable operation queue |
| `packages/portal-auth` (existing) | Validate ingress Bearer and Origin using `authenticatePortalRequest`; strip caller authorization from downstream MCP dispatch | Device credentials, tool authorization, Linux process management |
| Native Linux Agent (single Node.js process) | Private HTTP listener, device authentication, tool policy, Node.js file/search/process operations, local operation receipt store and owned sessions | MCP stdio client/server, Docker, vendor cloud, GUI, fleet management |
| Node.js standard-library runtime | `node:fs`, `node:fs/promises`, streams and `node:child_process` underpin the Agent's own operations | No second MCP protocol or `@wonderwhy-er/desktop-commander` package |
| Cloudflare VPC Service + outbound Tunnel | Worker-to-one-host:port private connectivity | Public application Tunnel, general private LAN routing, auto-wake, cloud job dispatch |

The existing application contexts and shared ingress token value for Database, IMA and Raindrop stay unchanged.

### Deployment and identity contract

- Exactly one Cloudflare Worker named `remote-control-mcp-worker` is proposed, served at an authenticated HTTPS `/mcp` endpoint following the repository's ingress convention. Public network accessibility of the **Worker** is expected; the **device Agent** must not be publicly reachable.
- One `vpc_services` HTTP binding targets one configured origin host and port through one private outbound Tunnel. The Worker calls **only the bound service**. No hostname, scheme, port or URL input is taken from MCP tool arguments; confirm the true VPC target and network namespace in the actual environment.
- The Linux Agent binds loopback/private interface appropriate to the Tunnel process. Do not assume that `127.0.0.1` is reachable across different network namespaces; prove connectivity.
- The native Node.js Agent and its managed child **development commands** run under the owner's **existing non-root Linux login account**; never launch with sudo/root. Verify actual group membership, sudoers, WSL mounts/interoperability and exposure of SSH or other credentials before activating unattended commands.
- Device lifecycle is simple supervised foreground/service execution with restart-on-failure where appropriate. No daemon dashboard, multi-device enrollment or host auto-wake.
- A sleeping PC, stopped WSL2, disconnected Tunnel or offline Agent produces **unavailable/error**, not a queued future execution or hidden retry.

## 4. Authentication and error contract

### Worker ingress

- `MCP_ACCESS_TOKEN` is a Worker runtime secret; its **value must be independently generated** and must not match the existing three-worker shared value.
- Require the `Authorization: Bearer` header through the actual Portal connection. Missing configuration => **503**; missing/invalid token => **401**; invalid Origin => **403**, consistent with existing middleware behavior.
- Existing `portal-auth` rejects an Origin header unless it matches configured allowlisted origins; a request without Origin may be accepted **only with a valid Bearer**. Configure exact verified Origin values if the real client sends one; do not relax caller authentication to fix client compatibility.
- Drop the ingress Authorization header before processing MCP tools; do not place it into internal requests, MCP responses, errors or logs. No anonymous bootstrap/health route may list file paths or host information.
- Static bearer proves possession only: no per-user OAuth identity, scopes or consent. A separate device-side secret is mandatory. Rotating the Worker credential must not require rotating other Workers.

### Device ingress

- Authenticate **every** forwarded request with the device-only credential, including status queries and health intended for internal use. Validate permitted tool name, parameters and bounded request size after authentication.
- Do not accept caller-supplied destination URLs, command execution callbacks, arbitrary process PIDs or unmatched operation IDs. Bad auth must never reach file APIs or process spawning.
- Use a small stable error taxonomy: `unauthorized`, `forbidden`, `bad_request`, `unavailable`, `timeout_unknown`, `not_found`, `conflict`, `internal_error`. Do not return stack traces, credentials or raw private request bodies.
- Worker/device timeout does **not** imply the operation was not executed. Never auto-retry mutation after an ambiguous transport outcome.

### Minimal private Agent HTTP interface

The Worker invokes only these **internal fixed-route operations** over its VPC Service binding; this is **not a public REST API**:

| Method and route | Required input | Response semantics |
| --- | --- | --- |
| `POST /internal/call` | `tool`, validated tool `arguments`, and `operation_id` for mutations | `{ operation_id?, status, result?, session_id?, error? }`. Status indicates `completed`, `running`, `failed` or `unknown`; large results must be paged/capped |
| `GET /internal/operations/{operation_id}` | Existing operation ID | Known receipt state / safe metadata, no implicit execution |
| `GET /internal/healthz` | Device credential | Minimal fixed health status; never expose user account name, paths, secrets, full runtime config or tool arguments |

The Agent authenticates all three routes before parsing or dispatching. The Worker **constructs** each internal request from the curated public MCP tool input; it never forwards arbitrary client HTTP headers, especially the Portal Bearer, caller-chosen URL or `Host`. Use the device-only authentication header accepted by the Agent and never expose that header as an MCP tool parameter.

If the response from a submitted mutation is lost, the Worker's output is `timeout_unknown` together with the **same known operation ID**, and an authenticated status lookup can reconcile it. A missing record is not evidence that a command never ran. No automatic Worker retry for mutations on network errors.

The exact internal header name and numeric limits are **implementation-local constants**, not new environment variables for every threshold. Choose bounded values in a single small config module and verify them using the S0/S2 cases; do not increase complexity with a remotely editable policy engine.

### Client compatibility blocking gate

The existing MCP Portal + ChatGPT client integration **must be empirically confirmed** to transmit the independent static Bearer credential. Current ChatGPT custom MCP connection screens do not supply a generic manual Bearer input; API-key declaration support in a plugin manifest is **not evidence that the submission UI will inject this token**. An unauthenticated direct-ChatGPT workaround is explicitly forbidden.

If the actual Portal connection cannot send the token, **stop at the read-only integration gate** and reopen the authentication/entrypoint design with the owner. Do not add OAuth silently or expose remote Shell through a no-auth server.

## 5. Tool and data contracts

The public tool set reuses **familiar tool names** from the Desktop Commander research only as product terminology; the implementation is **native Node.js**, not a byte-for-byte compatibility layer. The Agent performs bounded filesystem operations, streaming searches and supervised child processes. All paths obey the login account's actual OS permissions — **no app-level project path allowlist**.

| Capability | Exposed tool | Essential inputs | Essential behavior |
| --- | --- | --- | --- |
| File read | `read_file` | `path`, `offset?`, `length?` | **Local paths only**; reject `isUrl=true`; bounded/pageable text |
| Batch read | `read_multiple_files` | `paths[]` | Bounded file count and combined output |
| Directory list | `list_directory` | `path`, `depth?` | Bounded depth and item count |
| File metadata | `get_file_info` | `path` | Safe metadata, no unbounded contents |
| Search | `start_search`, `get_more_search_results`, `stop_search` | `path`, `pattern`, search session ID and pages | File-name/content search, paged results and explicit stop; search has local lifetime |
| Create/write | `write_file` | `operation_id`, `path`, `content`, `mode` rewrite/append | Receipt before mutation; return operation outcome |
| Create directory | `create_directory` | `operation_id`, `path` | Receipt before mutation |
| Text edit | `edit_block` | `operation_id`, `file_path`, `old_string`, `new_string`, `expected_replacements?` | Text replacement only in v1, no arbitrary structured `options` pass-through; receipt |
| Move/rename | `move_file` | `operation_id`, `source`, `destination` | Receipt before mutation; reject no-match/argument conflict |
| Start command | `start_process` | `operation_id`, `command`, `timeout_ms?` | Execute development Shell as the existing account; return a managed session ID if ongoing |
| Process input | `interact_with_process` | `operation_id`, `session_id`, `input` | Input only into a verified Agent-owned session; receipt |
| Process output | `read_process_output` | `session_id`, `offset?`, `length?` | Paged/bounded output; status and EOF |
| Process listing | `list_sessions` | none | Only Agent-owned tracked sessions |
| Stop session | `force_terminate` | `operation_id`, `session_id` | Terminate only proven owned session/process group; receipt |
| Mutation state | `get_operation_status` (thin Agent wrapper) | `operation_id` | Return known receipt status, never execute work |

**Critical details:**

- `operation_id` is a client-visible opaque unique ID supplied with every mutation; it must be stable across transport retries and returned in every mutation response. The adapter maps it to a canonical `tool+arguments` digest. Same ID with different effective parameters => **`conflict`**, never execute. Missing/invalid ID => `bad_request`. Do not assume an LLM can reliably remember a lost ID: provide instructions/examples in tool metadata and let clients query status with the original ID. A genuinely new intent requires a new ID.
- The Agent maps its session IDs to verified process instances. **Never accept a raw host PID as remote process ownership**; guard against PID reuse and post-restart stale IDs. Search session IDs are separate from process session IDs.
- Do not expose configuration mutation, runtime secret inspection, all-host-process listing, arbitrary `kill_process(pid)`, PDF-generation, tool-call-history download, telemetry/feedback or unrelated tools. The Agent must not implement an unrestricted general-purpose upstream-tool dispatcher.
- Do not implement `node:local` virtual code sessions or `read_file(isUrl=true)` remote URL fetching. File tools accept local filesystem paths; Shell remains a separately authorized capability.
- Public `start_process` must not accept a client-chosen shell executable path; use a fixed, locally selected shell and `child_process.spawn` with explicit argument construction. Shell text is executed as the existing OS user, **not confined** by a command blacklist.
- Narrow tool exposure **does not contain arbitrary authorized Shell**. Prompt injection, destructive commands, reading reachable secrets or executing additional binaries remain possible within the existing user's OS permissions. The product **must not claim otherwise**.

### Native Linux Agent implementation contract

- **Files:** use `node:fs/promises` for metadata, directory operations and mutation; implement `read_file` with bounded streaming/line windows rather than unbounded whole-file reads. Keep results and pagination capped; report OS permission errors without exposing private paths in diagnostics. Text editing uses explicit `old_string/new_string/expected_replacements` checks, and writes are protected by Operation Receipts.
- **Search:** walk directories with bounded depth, active-search count, time and output. Use Node.js native traversal and line streaming for the v1 name/content search; no indexing service or additional search dependency by default. Handle symlink loops and traversal errors without falsely promising directory isolation or unrestricted search throughput.
- **Processes:** use `node:child_process.spawn` with a locally fixed Shell path; bound command submission, stdout/stderr buffer and active sessions. Track the child and owned process group under an opaque session ID. Stdin/stdout pipes support ordinary development processes; **PTY/fully interactive terminal programs are explicitly not promised in v1**.
- **Receipts:** keep all side-effect state and sessions local to this Agent; a single minimal store supplies atomic admission, idempotency and status reconciliation. Do not add generic executor engines, adapter registries, a second MCP transport or a cloud state store.
- **T01 migration:** preserve the closed [T01 #3](https://github.com/lirtual/mcp-workers/issues/3) as a historical delivered slice; the next prerequisite is to replace only its Desktop Commander `read_file` subprocess with native Node.js and remove orphaned stdio-client packages before the [T02 #4](https://github.com/lirtual/mcp-workers/issues/4) real client/Tunnel test. No functionality beyond that small read-only seam is required for the migration.

### Minimal state schema (local only)

**OperationReceipt:** `operation_id` (unique), `tool_name`, `argument_digest`, `state`, `created_at`, `updated_at`, `session_id?`, `safe_result_summary?`. State is one of `admitted`, `running`, `completed`, `failed`, `unknown`. Persist an **atomic admission record before dispatch**. After crash, any previously admitted/running operation without provable final effect is `unknown`, not `failed` or `safe_to_retry`.

**ManagedSession:** `session_id` (unguessable opaque identifier), `process_identity` (local verified process instance, never bare PID only), `state`, `started_at`, `last_observed_at`, `output_cursor`. The session owner is this Agent instance/record. Unknown/stale ownership after restart means deny stdin/stop until verified; never target an unrelated PID.

A single small device-local durable store is permitted. Its storage implementation (atomic file/SQLite or equivalently small standard library facility) is an implementation choice; **no cloud database or distributed queue**. Avoid raw tool arguments, file contents, command stdout and secrets in the receipt database. Bounded retention/cleanup is required; active and uncertain receipts cannot be discarded while a client may still query them, and expiry must be represented honestly as `not_found`/expired, never as a proven failure.

## 6. Lifecycle and failure behavior

- A user may run a long process beyond the initiating MCP HTTP call. Reattach only through a verified owned session ID; paginate stdout. Do **not** automatically restart existing commands on Agent restart.
- Stop targets a verified Agent-owned process group via a graceful signal, then a bounded forced signal **only for the same verified instance** if necessary. A host PID on its own never proves ownership; PID reuse and process-group identity require explicit tests.
- On disconnected Agent/Tunnel, return `unavailable` for calls not submitted and `timeout_unknown` for any submitted mutation whose effect cannot be excluded. Do not silently enqueue or replay.
- For a duplicate mutation with the same ID and digest, return current known status (or safe summary) rather than executing again; if effects are unknowable, return `unknown`.
- Avoid preemptively rolling back file writes or killing uncertain processes on network disconnect; doing so could cause additional untracked side effects.
- For v1, processes are **not promised to survive Agent or machine restart**; clean restart may re-create Agent supervision but never silently respawn an uncertain command.

## 7. Privacy and security requirements

- Existing user OS permissions are the **actual** control plane. Before unattended Shell, inspect (read-only) account UID, group memberships, passwordless sudo, container runtime/socket access, SSH/cloud credentials and WSL2 Windows filesystem/interop if applicable. An effectively admin-capable account means Shell can wield that power. Require explicit informed risk acceptance or change OS access before enabling unattended Shell.
- Run the Agent and child development commands without sudo/root. Protect local receipt store, session output and device credentials using owner-only permissions (`0700` directory, `0600` file or OS-equivalent).
- **No Desktop Commander telemetry or tool-history files** are created by the final native Agent. Its own logging is intentionally minimal and must not persist raw arguments, file contents, environment values, Shell input or stdout/stderr outside bounded owner-protected session output. There is no optional vendor telemetry configuration to manage.
- Do not log Authorization, device secrets, raw file contents, sensitive tool parameters, stack traces or complete session output into Cloudflare/Agent diagnostics. Scrub errors; verify native log redaction with synthetic secrets and no remaining Desktop Commander history writes.
- Do not depend on blocked-command lists, pathname filters, read-only MCP annotations or natural-language model instructions to enforce a Linux privilege boundary.
- Treat remote text/files/command output as **untrusted data**, not instructions to broaden allowed actions. Expose correct `readOnlyHint`/`destructiveHint` tool metadata and use normal ChatGPT approval behavior, but maintain server-side authorization independently.

## 8. Implementation slices and test seams

Use the **highest externally observable seams**: Worker `/mcp` authentication/tool semantics, Agent private HTTP call invoking **native Node.js** file/process operations against disposable fixtures, and a limited hosted ChatGPT/Portal + VPC Service smoke test. Avoid a large mock network or per-private-function tests. Existing repository Node/pnpm/Vitest conventions should be reused. **Do not create GitHub Actions/CI workflows by default.**

| Slice | Scope | Blocking verification |
| --- | --- | --- |
| S0 — Contracts/offline | Keep closed T01's Worker/Agent read-only seam; replace its Desktop Commander adapter with native Node.js filesystem read, remove obsolete dependencies, keep fixed VPC target config; no mutating tools enabled | No/invalid Bearer denied; Origin checks; bad device token denied; no arbitrary host/URL forwarding; tool list exactly scoped |
| S1 — Read-only hosted proof | Worker + private Tunnel/VPC Service + innocuous fixed fixture, real Portal/ChatGPT path | Authorized initialize/list/read succeeds; all negative auth paths denied; offline fails closed. **If static Bearer delivery cannot be shown, stop.** |
| S2 — File/search | Paged reads, list/search, then receipts and selected writes | Large output bounded, read errors clean; duplicate-ID writes do not replay, argument mismatch conflicts; permission errors follow OS |
| S3 — Shell/sessions | Preflight login-account risk, command execution, owned session state/input/stop and restart semantics | Proven process ownership, no bare PID control, no `node:local`, no unexpected automatic retry/relaunch, redaction/retention verified |
| S4 — Release decision | Clean read-only and write/Shell security evidence plus rollback operator runbook | Operator explicitly authorizes private infrastructure/deployment and high-privilege Shell exposure; version/rollout evidence recorded |

### Behavior-driven acceptance matrix

1. Given a missing `MCP_ACCESS_TOKEN` Worker secret, when a client calls `/mcp`, then the Worker returns an unavailable/misconfigured error and **does not contact the device**.
2. Given missing, incorrect or unapproved-Origin credentials, when a client initializes or invokes any tool, then ingress rejects it before MCP execution.
3. Given the real Portal path with **a distinct Remote Control token**, when a trusted client initializes, lists tools and reads a fixed non-secret fixture, then all work succeeds through the private VPC Service and Agent. If not, S1 fails; the implementation cannot proceed to Shell.
4. Given an invalid device credential, when a Worker-like request reaches the Agent, then the Agent denies it before any native filesystem access or process spawn.
5. Given a correct read request for a large fixture, when output is fetched, then pages/caps are enforced and no oversized Worker response is produced.
6. Given a mutating request `X`, when `X` is repeated with identical ID and arguments after a dropped response, then it does not create a second side effect and status is retrievable.
7. Given a repeated ID but changed arguments, when it reaches the Agent, then the request is rejected as a conflict with **no new side effect**.
8. Given a crash/timeout after dispatch, when the client checks status, then the status is `unknown` unless a final effect is provable; no automatic retry occurs.
9. Given a managed development session, when the initiating HTTP request ends, then the owned process remains queryable and readable by session ID where supported.
10. Given a forged/stale session ID or reused host PID, when the client sends input or stop, then the Agent rejects it and leaves unrelated processes unchanged.
11. Given Agent restart, when the client revisits a past session, then its state is accurately reconciled or marked stale/unknown and the command is **not** silently relaunched.
12. Given a `node:local` or `read_file(isUrl=true)` invocation or nonexistent administrative tool name, when invoked remotely, then Worker/Agent reject it before filesystem or process operations.
13. Given the actual non-root login account, when the preflight checks privilege paths and local history privacy, then risks are documented and unattended Shell remains disabled pending any required explicit risk acceptance.
14. Given a disconnected private Tunnel or stopped WSL2 environment, when a caller requests work, then the Worker fails closed/unavailable rather than using a public fallback or queued replay.
15. Given a rotated Remote Control ingress token, when callers use the old token, then only Remote Control access is rejected; other MCP Workers retain their prior shared token values and availability.
16. Given synthetic sensitive file names, parameters and command output, when the native Agent is exercised, then Cloudflare/Agent diagnostic logs exclude their raw values and bounded local session output has owner-only permissions; the native Agent never creates vendor tool-history files.

### Exit criteria for spec-to-implementation handoff

- The owner approves this spec and acknowledges that the ordinary Linux user is **not isolated**.
- The S1 Portal/ChatGPT static Bearer compatibility test is defined as an unconditional **stop/go gate**, not a presumed success.
- The implementer can identify Worker/Agent boundaries, native file/search/process modules, local receipt/session contracts, and out-of-scope paths without designing an unrelated subsystem.
- Implementation starts with **read-only S0/S1**. Permission to create Cloudflare resources, provision credentials and expose mutating tools remains a separate owner action.

## 9. Explicitly out of scope

- OAuth/GitHub login, OAuth KV, a second authorization Worker, reusing the Database/IMA/Raindrop token **value**, anonymous remote Shell.
- Docker/VM sandbox, dedicated Linux service account, application project-path allowlist, automated sudo/admin privilege escalation.
- GUI/desktop video, mouse/keyboard, native Windows remote control, WSL2-specific tool protocol.
- Publicly published Agent endpoint, generic VPC Network routing, arbitrary HTTP proxy, multiple device enrollment or router, web dashboard.
- Reimplementation of file/Shell/search engines, cloud relay, cloud job queue, exactly-once effects, remote auto-wake or persistence of arbitrary commands across host restart.
- Remote configuration mutation, global host-process listing/termination, remote URL fetching through file tools, `node:local`, PTY/full terminal emulation, PDF/document-specialist extras or an extensible plugin/engine framework.
- Additional telemetry pipeline, cloud D1/R2/DO/Queues/Workflows just to store operation state, or any new CI workflow by default.

## 10. Decision references and research evidence

- Local architecture: [CONTEXT](./CONTEXT.md), [ADR-0004](./adr/0004-vpc-only-private-device-transport.md), [ADR-0007](./adr/0007-local-receipts-and-no-blind-replay.md), [ADR-0008](./adr/0008-curated-mcp-tool-surface.md), [ADR-0009](./adr/0009-owned-managed-process-sessions.md), [ADR-0011](./adr/0011-direct-linux-user-no-path-allowlist.md), [ADR-0012](./adr/0012-reuse-portal-bearer-auth-with-independent-secret.md).
- Codebase seams: `packages/portal-auth/src/index.ts`, `apps/raindrop-mcp-worker/src/worker.ts`, `docs/ingress-policy.md`, existing Worker security tests and root `scripts/mcp-smoke.mjs`.
- Architectural **reference only**: [Remote Desktop Commander](https://github.com/wonderwhy-er/DesktopCommanderMCP/tree/main/src/remote-device) and [DesktopCommanderMCP](https://github.com/wonderwhy-er/DesktopCommanderMCP). Neither package nor its hosted relay is a v1 runtime dependency; see [ADR-0013](./adr/0013-native-nodejs-linux-agent.md).
- [Cloudflare Workers VPC Services](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/): fixed host/port target, private Tunnel, HTTP scheme/Host-header behavior, beta status; validate current terms at rollout.
- [OpenAI custom MCP connection documentation](https://developers.openai.com/api/docs/guides/custom-mcp-server) and [Plugin submission authentication limitations](https://developers.openai.com/plugins/deploy/submission): direct UI's auth and unsupported generic API-key input are reasons for the mandatory Portal compatibility gate.

**No implementation code, production changes, user secrets or issue/ticket graph are created by this specification.**
