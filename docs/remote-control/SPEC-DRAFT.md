# Remote Control MCP — Minimal v1 specification (approval draft)

> **Status: design draft for final operator approval (2026-10-12). Not implemented or deployed.**
> Accepted decisions are documented in [CONTEXT.md](./CONTEXT.md) and ADR-0001 through ADR-0012, with later ADRs superseding earlier ones. This specification consolidates those decisions; implementation details labeled **proposed default** still require verification, not presumed approval.
> Baseline research: [RESEARCH-DRAFT.md](./RESEARCH-DRAFT.md). Unlike the original WSL2/VPC-only research probe, this v1 product is Linux-first and uses the existing MCP Portal Bearer pattern.

## 1. Goal and v1 scope

One person controls **one Linux host** through an authorized MCP client. WSL2 Linux is a possible deployment environment, not a core dependency. V1 supports file reads/edits, directory listing, file/content search, development Shell and managed long-running process sessions. No screen sharing/GUI, native Windows control, multi-device routing, host administration framework or bespoke execution engine.

**Operator-approved simplification:** the local Agent runs as the operator's **existing ordinary non-root Linux login user**. There is **no Docker requirement, no dedicated service account and no project-directory allowlist**. Working directories are convenience hints, not security boundaries. File/Shell reach equals the user's actual OS permissions, including any credentials, mounted filesystems and privilege-escalation paths the user already possesses.

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
- **Blocking compatibility condition:** validate the *actual* ChatGPT/MCP Portal path supplies the static Bearer. A direct custom ChatGPT plugin flow is **not assumed** to allow static Bearer configuration. If it does not work, halt rollout and reopen the ingress decision, never silently disable authentication.
- Treat this token as highly privileged: once stolen, it can expose the existing Linux user's accessible files via allowed remote tools.

## 4. MCP tool contract — proposed initial allowlist

Use upstream Desktop Commander local stdio tools rather than reimplementing them. The names below are drawn from the upstream README; exact arguments and behavior require source review and tests.

| Class | Candidate upstream tools | v1 rule |
| --- | --- | --- |
| Read / list | `read_file`, `read_multiple_files`, `list_directory`, `get_file_info` | User-account permissions; bounded output and pagination |
| Find | `start_search`, `get_more_search_results`, `stop_search` | Limit active searches and output; no host-privileged indexing |
| Write / edit | `write_file`, `edit_block`, `create_directory`, `move_file` | Explicit mutating operation ID + receipt; user-account permissions |
| Run | `start_process` | Local Shell as the existing login user, no automatic privilege elevation; receipt before launch |
| Session | `interact_with_process`, `read_process_output`, `list_sessions`, `force_terminate` | Only processes/sessions owned and tracked by this Agent |

- **Do not expose** `set_config_value`, `kill_process` by arbitrary PID, `list_processes` of the whole host, upstream telemetry/feedback tools or unreviewed new upstream tools in v1.
- Tool names and schemas presented to the remote client may be narrow wrappers rather than raw upstream capabilities. An upstream version upgrade must not automatically expand the remote tool surface.
- **No project directory allowlist.** All path-based operations inherit ordinary Unix file permissions. Symbolic links or a working directory must not be presented as stronger isolation.
- Tool-list selection does **not** restrict what a permitted arbitrary Shell command can do. Never promise denial of `sudo`, Docker socket operations or access to account-readable secrets unless the OS actually denies them.

## 5. Local execution and session semantics

- Run Agent and locally supervised pinned Desktop Commander subprocess as the existing user, without `sudo`/root launcher. Do not create a duplicate remote command executor.
- The local Agent exposes only a fixed, privately reachable endpoint and rejects unauthorized device calls or unrecognized tool names/arguments.
- Managed processes may outlive the MCP request that started them. Device owns session IDs and enforces that session input/read/stop apply only to its own tracked processes.
- On Agent restart, **proposed default:** do not relaunch prior processes automatically. Reconcile what can be proven; mark uncertain sessions `stale`/`unknown`. Do not terminate unrelated host processes.
- Bound request sizes, returned text, concurrent sessions and stored output. Large results need explicit pagination/truncation, not unbounded Worker responses. Concrete numeric limits should be validated using a real dev workload, not inherited blindly from the tiny R03 read-only probe.

## 6. Failure behavior and minimal local records

- Each state-changing operation, including file edits, process launch, process input and stop, has a stable ID. Persist a minimal **device-local durable receipt before side effects**.
- On duplicate ID, return the known result/status instead of running the effect twice. A timeout/disconnect after possible execution yields `unknown` or status lookup; do **not** blindly retry.
- Maintain only necessary local operation metadata (ID, type, started/finished times, status and optional safe result reference). No cloud queue, DO, R2, D1, central job scheduler or long-term sensitive output archive. **Proposed default:** bounded local cleanup and redacted stdout/logs; exact retention is an implementation detail.
- Underlying process and files may not be transactionally recoverable. **No exactly-once execution claim.**

## 7. No-go conditions and acceptance checks

A read-only fixture must pass **before** enabling file writes or Shell:

1. Portal-to-Worker-to-device authenticated MCP initialize, tool listing and a harmless read-only call; verify actual ChatGPT usability rather than only a curl probe.
2. Missing/wrong Portal Bearer is denied; leaked/incorrect device credential is denied; no upstream token is forwarded; no public device URL or arbitrary destination routing.
3. Linux process runs as the **chosen ordinary existing login user** and **not root**. Inspect effective `id`, `sudo -n`/sudoers behavior, container-runtime group/socket permissions, accessible SSH/service credentials and WSL2 interop/mounts if relevant. **If existing account is effectively administrative without consent, do not claim host isolation or enable unattended Shell without a new explicit risk decision.**
4. Review pinned upstream package version, install integrity and its file/Shell semantics. Check unreviewed tools are unavailable remotely; command-level directory blacklists are never treated as a sandbox.
5. Confirm the private Tunnel/VPC Service has a single restricted listener, offline failure is closed, and there is no public fallback.
6. Confirm side-effect request timeout/repeat leads to status/`unknown`, not duplicated writes or launches; restart does not silently respawn sessions; session stop cannot affect an unrelated PID.
7. Verify secret redaction, bounded stdout/output, no plaintext token storage in logs, and safe token rotation/revocation.

## 8. Delivery boundaries and explicit non-goals

No new CI workflows unless a later requirement demonstrates the need; reuse existing test conventions and run tests locally as needed. No changes to active Database/IMA/Raindrop Workers, shared production secrets, or existing Cloudflare resources until separately approved. No OAuth provider, Docker requirement, project directory ACL, GUI, native Windows service, multi-device support or custom cloud relay.

**Operator-approved decisions are final as product direction; this document and all numeric/tool-level defaults remain a specification draft until explicit final acceptance.** The first proposed implementation milestone is the authenticated, private, **read-only** end-to-end probe, not unrestricted Shell deployment.
