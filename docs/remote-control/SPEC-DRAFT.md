# Remote Control MCP — Minimal v1 specification (approval draft)

> **Status: design draft for final operator approval (2026-10-12). Not implemented or deployed.**
> Accepted decisions are documented in [CONTEXT.md](./CONTEXT.md) and ADR-0001 through ADR-0012, with later ADRs superseding earlier ones. This specification consolidates those decisions; implementation details labeled **proposed default** still require verification, not presumed approval.
> Baseline research: [RESEARCH-DRAFT.md](./RESEARCH-DRAFT.md). Unlike the original WSL2/VPC-only research probe, this v1 product is Linux-first and uses the existing MCP Portal Bearer pattern.

## 1. Goal and v1 scope

One person controls **one Linux host** through an authorized MCP client. WSL2 Linux is a possible deployment environment, not a core dependency. V1 supports file reads/edits, directory listing, file/content search, development Shell and managed long-running process sessions. No screen sharing/GUI, native Windows control, multi-device routing, host administration framework or bespoke execution engine.

**Operator-approved simplification:** the local Agent runs as the operator's **existing ordinary non-root Linux login user**. There is **no Docker requirement, no dedicated service account and no project-directory allowlist**. Working directories are convenience hints, not security boundaries. File/Shell reach equals the user's actual OS permissions, including credentials, mounted filesystems and any existing privilege-escalation paths. A promise of no host administration **cannot be enforced by a tool allowlist** once arbitrary Shell is exposed; implementation must accurately disclose and test that risk.

## 2. Accepted minimal topology

```text
ChatGPT / compatible MCP Portal client
       |
       | Portal supplies Authorization: Bearer <Remote Control-specific secret>
       v
1 Cloudflare remote-control-mcp-worker, /mcp
       | existing @mcp-workers/portal-auth authentication
       | fixed Workers VPC Service binding; never forward Portal Bearer
       v
Private outbound Cloudflare Tunnel (no public adapter route)
       v
Linux loopback Agent / thin HTTP-to-local-stdio bridge
       | separate adapter authentication + curated-tool validation
       | local operation receipts and owned session tracking
       v
Pinned @wonderwhy-er/desktop-commander local stdio MCP child
       |
       v
Existing ordinary Linux login user's filesystem / Shell / processes
```

One Worker, one Linux Agent, one VPC Service fixed to one host/port and one dedicated Tunnel. The private device endpoint must not be an internet-facing published Tunnel application or generic open proxy. Verify VPC Service route reachability and Linux listener namespace on the target deployment.

## 3. Authentication and trust boundaries

- Reuse the existing repository `@mcp-workers/portal-auth` middleware. Require a runtime secret named `MCP_ACCESS_TOKEN`, with a **new high-entropy value not shared** with Database, IMA or Raindrop workers. Missing or wrong Bearer fails closed before tool dispatch.
- **No** GitHub OAuth login, OAuth authorization endpoint, OAUTH_KV, consent UI or custom identity platform in v1. Portal static Bearer proves token possession; it is not individual-user OAuth authorization.
- Worker-to-device requests use a **different dedicated secret**, verified by the Linux Agent; strip/never propagate Portal credentials. Tool and argument validation occurs at the device too.
- Token values never go in Git, logs, trace metadata or tool output. Rotation is an operator task. No anonymous fallback.
- **Blocking compatibility condition:** validate the *actual* ChatGPT/MCP Portal path supplies the static Bearer. The current ChatGPT custom-plugin instructions list OAuth, no authentication and mixed authentication, **not** a general manual static-Bearer field. This design relies on the existing Portal route; it must pass authenticated initialization, tools/list, a safe fixed read-only fixture, and negative authentication cases. If it cannot provide the header, halt and reopen the ingress decision; never disable authentication.
- Treat this token as highly privileged: once stolen, it can expose the existing Linux user's accessible files via allowed remote tools. The repository's current portal-auth defaults to rejecting requests with an Origin header unless the Origin is explicitly allowed; verify whether this client's ingress carries Origin, and configure exact trusted origins if needed instead of globally permitting unknown origins.

## 4. MCP tool contract — proposed initial allowlist

Use upstream Desktop Commander local stdio tools rather than reimplementing them. The names below are drawn from the upstream README; exact arguments and behavior require source review and tests.

| Class | Candidate upstream tools | v1 rule |
| --- | --- | --- |
| Read / list | `read_file`, `read_multiple_files`, `list_directory`, `get_file_info` | User-account permissions; bounded output and pagination |
| Find | `start_search`, `get_more_search_results`, `stop_search` | Limit active searches and output; no host-privileged indexing |
| Write / edit | `write_file`, `edit_block`, `create_directory`, `move_file` | Explicit mutating operation ID + receipt; user-account permissions |
| Run | `start_process` | Local Shell as the existing login user, no automatic privilege elevation; receipt before launch |
| Session | `interact_with_process`, `read_process_output`, `list_sessions`, `force_terminate` | Only processes/sessions owned and tracked by this Agent |

- **Do not expose** `set_config_value`, `kill_process` by arbitrary PID, `list_processes` of the whole host, upstream telemetry/feedback tools or unreviewed new upstream tools in v1. Also exclude the upstream special `start_process(command="node:local")` virtual-code session because it does not map to an ordinary supervised process. Limit `read_file` to local file paths in this file-management contract; its upstream `isUrl` mode is a separate network-fetch capability and is not required for v1.
- Tool names and schemas presented to the remote client may be narrow wrappers rather than raw upstream capabilities. An upstream version upgrade must not automatically expand the remote tool surface. These narrow wrappers do not provide a guarantee against equivalent actions through a deliberately authorized arbitrary Shell; treat them as interface/ownership rules, not sandbox rules.
- **No project directory allowlist.** All path-based operations inherit ordinary Unix file permissions. Symbolic links or a working directory must not be presented as stronger isolation.
- Tool-list selection does **not** restrict what permitted arbitrary Shell or stdin into an interactive Shell can execute. Never promise denial of `sudo`, container-runtime/socket access or account-readable secrets unless the **operating system** actually denies them. If this login account has effective administrator capabilities, record and explicitly accept that consequence before unattended Shell; otherwise stop activation.

## 5. Local execution and session semantics

- Run Agent and locally supervised pinned Desktop Commander subprocess as the existing user, without a `sudo`/root launcher. Do not create a duplicate remote command executor. Review upstream local configuration explicitly: the inspected upstream default `allowedDirectories: []` permits all filesystem paths for file tools; an existing nonempty upstream configuration can still unintentionally restrict access, so verify its actual state rather than assuming our lack of a separate allowlist is enough.
- The local Agent exposes only a fixed, privately reachable endpoint and rejects unauthorized device calls or unrecognized tool names/arguments.
- Managed processes may outlive the MCP request that started them. Device owns session IDs and enforces that session input/read/stop apply only to its own tracked processes. Do not use a raw PID alone as proof of ownership after restart or PID reuse; a remote session handle must map to a verified tracked process instance.
- On Agent restart, **proposed default:** do not relaunch prior processes automatically. Reconcile what can be proven; mark uncertain sessions `stale`/`unknown`. Do not terminate unrelated host processes. If a managed process escapes the original child process lifetime, its identity and stop ownership must be proven rather than inferred from PID alone.
- Bound request sizes, returned text, concurrent sessions and stored output. Large results need explicit pagination/truncation, not unbounded Worker responses. Concrete numeric limits should be validated using a real dev workload, not inherited blindly from the tiny R03 read-only probe. A sleeping/offline Linux machine (or stopped WSL2 environment/Tunnel/Agent) is unavailable by design; do not add a cloud queue or imply that a private Tunnel can wake it.

## 6. Failure behavior and minimal local records

- Each state-changing operation, including file edits, process launch, process input and stop, has a stable ID carried consistently across transport retries. Persist a minimal **device-local durable receipt before side effects** and associate the ID with the exact operation/arguments; the Agent must reject reuse of one ID with different arguments.
- On duplicate ID, return the known result/status instead of running the effect twice. A timeout/disconnect after possible execution yields `unknown` or status lookup; do **not** blindly retry.
- Maintain only necessary local operation metadata (ID, type/argument digest, started/finished times, status and optional safe result reference). No cloud queue, DO, R2, D1, central job scheduler or long-term sensitive output archive. **Proposed default:** bounded receipt cleanup and redacted Agent/Worker logs; exact retention is an implementation detail. **Important upstream exception:** the pinned Desktop Commander subprocess writes tool arguments without redaction to `~/.claude-server-commander/claude_tool_call.log` and saves limited outputs in `tool-history.jsonl`. Inspect upstream log settings, ownership, permissions and retention and prevent secrets in tool arguments before production. The upstream default telemetry setting is enabled; choose/verify the desired privacy setting explicitly, rather than assuming it is off.
- Underlying process and files may not be transactionally recoverable. **No exactly-once execution claim.**

## 7. No-go conditions and acceptance checks

A read-only fixture must pass **before** enabling file writes or Shell:

1. Portal-to-Worker-to-device authenticated MCP initialize, tool listing and a **fixed harmless, non-secret read-only fixture**; verify actual ChatGPT usability rather than only a curl probe. A general-purpose `read_file` pointing to arbitrary user paths is **not** a safe security probe.
2. Missing/wrong Portal Bearer is denied; leaked/incorrect device credential is denied; no upstream token is forwarded; no public device URL or arbitrary destination routing.
3. Linux process runs as the **chosen ordinary existing login user**, not root. Inspect effective `id`, `sudo -n`/sudoers behavior, container-runtime group/socket permissions, reachable SSH/service credentials and WSL2 interop/mounts if relevant. If that existing account effectively has administrator privileges, **unattended Shell would share those abilities regardless of excluding administrative MCP tools**. Require explicit risk acceptance or adjust OS rights before activation; do not claim host isolation.
4. Review pinned upstream package version, install integrity and its file/Shell semantics. Check unreviewed tools are unavailable remotely; command-level directory blacklists are never treated as a sandbox.
5. Confirm the private Tunnel/VPC Service has a single restricted listener, offline failure is closed, and there is no public fallback. Current Cloudflare guidance requires a supported `cloudflared` version (2025.7.0+) and QUIC connectivity (outbound UDP 7844); test VPC Service host/port binding and Linux network namespace. Workers VPC is still beta and currently free during beta; recheck limits/pricing before rollout.
6. Confirm side-effect request timeout/repeat leads to status/`unknown`, not duplicated writes or launches; restart does not silently respawn sessions; session stop cannot affect an unrelated PID.
7. Verify secrets are excluded from Worker/Agent logging and exception messages, and account for upstream Desktop Commander **unredacted local argument history and bounded result history** separately. Confirm owner-only filesystem permissions, explicit local history retention/cleanup, telemetry setting, bounded output, safe token rotation/revocation, and no diagnostic leakage of client/device credentials.
8. Confirm the remote client cannot call `node:local`, `read_file(isUrl=true)`, general upstream configuration mutation or arbitrary host-PID management. Verify `start_process`, process input and file writes are safe **only to the degree of the existing Linux user's OS permissions**. Test one session identity/restart case and one denial case without executing dangerous payloads.

## 8. Delivery boundaries and explicit non-goals

No new CI workflows unless a later requirement demonstrates the need; reuse existing test conventions and run tests locally as needed. No changes to active Database/IMA/Raindrop Workers, shared production secrets, or existing Cloudflare resources until separately approved. No OAuth provider, Docker requirement, project directory ACL, GUI, native Windows service, multi-device support or custom cloud relay.

**Operator-approved decisions are final as product direction; this document and all numeric/tool-level defaults remain a specification draft until explicit final acceptance.** The first proposed implementation milestone is the authenticated, private, **read-only** end-to-end probe, not unrestricted Shell deployment.
