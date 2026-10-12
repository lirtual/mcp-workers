# Remote Control MCP — research draft and grilling frontier

> Status: **Research draft; Round 1 F1=A, F2=A, F3=A, F4=A accepted** on 2026-10-12. Execution isolation, unattended authority, failure recovery, actual OAuth implementation, tool schemas and rollout are NOT accepted.
> This is not an implementation specification or deployment authorization. Accepted decisions live in linked ADRs; all uncited implementation patterns below remain proposals.
> Baseline: user-provided `Remote-Desktop-MCP-Spec-VPC-only(1).md` (R03 research contract, based on commit `e9764b73f9ce8894ccda6e4427bfd5ad3ee16fb5`). The old branch was not located in current branch search; the user's supplied copy is the source for that baseline.
> No existing production worker, secret, tunnel, or GitHub Actions workflow is changed.

## Settled decisions and records

- Product name: **Remote Control MCP**; proposed Worker/app id: `remote-control-mcp-worker`.
- Target execution model: **Linux-first** (WSL2 is a deployment variant, not a prerequisite).
- Accepted v1 feature contract (F1=A and F3=A): workspace file read/write, search, development Shell and managed processes; no host-wide administration, GUI/screen/mouse/keyboard or native Windows in v1. [ADR-0002](./adr/0002-v1-workspace-control-scope.md).
- Independent OAuth and directly connectable remote MCP clients (F2=A); existing shared `MCP_ACCESS_TOKEN` must not grant local host control. [ADR-0003](./adr/0003-independent-oauth-for-direct-mcp-clients.md).
- VPC-only private transport via exact VPC Service target and outbound Tunnel, no publicly published device endpoint or public fallback (F4=A). [ADR-0004](./adr/0004-vpc-only-private-device-transport.md).
- Domain vocabulary: [CONTEXT.md](./CONTEXT.md); platform choice: [ADR-0001](./adr/0001-linux-first.md).
- The **manner of enforcing** a workspace boundary for arbitrary Shell, unattended permission and durable operation results is NOT yet decided.

## Evidence and source boundaries

1. [Remote Desktop Commander public repository](https://github.com/desktop-commander/remote-desktop-commander): hosted OAuth + device pairing + relay; hosted backend is proprietary, public repo holds docs/manifests. Its `npx @wonderwhy-er/desktop-commander@latest remote` joins the vendor-hosted device service; it is **not** the command for self-hosted VPC execution.
2. [DesktopCommanderMCP](https://github.com/wonderwhy-er/DesktopCommanderMCP): MIT local stdio MCP engine. The reviewed `package.json` currently specifies `0.2.52`; pin and verify an exact distribution/integrity before deployment, never use `@latest` in production. The repository includes file read/write, search, terminal, sessions/processes, configuration changes and document capabilities.
3. [Upstream security model](https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/main/SECURITY.md): allowed directories, command blocklists, and symlink checks are guardrails, **not a shell sandbox**. Use an isolated OS user/container/VM if containment is required.
4. [Cloudflare Workers VPC Services](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/) and [bindings API](https://developers.cloudflare.com/workers-vpc/api/): bind one exact host:port over a private tunnel; a VPC Service's target controls routing rather than the Host supplied to `fetch()`. Beta/free status is subject to change.
5. [Cloudflare Workers OAuth Provider v1](https://github.com/cloudflare/workers-oauth-provider): for **one resource and one person**, its one-Worker `OAuthProvider` is supported (in addition to separate auth/resource Workers); KV `OAUTH_KV` is necessary. GitHub identity, actual consent, redirect protections, token/resource audience and PKCE must be verified.
6. [MCP 2026-07-28 auth specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization): latest researched published auth guidance, differing from the original R03 probe's locked `2025-11-25` protocol. Negotiate/test protocol and client compatibility instead of blindly hardcoding the legacy probe version.
7. [ChatGPT custom MCP plugin guidance](https://developers.openai.com/api/docs/guides/custom-mcp-server): OAuth supported; client registration/discovery, tool invocation rights, and actual account availability require end-to-end testing.
8. Current `mcp-workers/main` contains only `apps/database-mcp-worker`, `apps/ima-mcp-worker`, and `apps/raindrop-mcp-worker`. Its `MCP_ACCESS_TOKEN` is shared across those three; extending that same value to a high-risk remote Shell worker would increase blast radius. Existing `portal-auth` can provide conventions, not automatic authorization for host access.

## Baseline VPC-only requirements (F4 accepted; implementation details still to validate)

- VPC Service (not VPC Network), private cloudflared tunnel, no public origin listener and no user-selected downstream host/port.
- Outer client auth, separate device auth, and device-side tool/argument/path policy are separate checks. No OAuth bearer forwarding to device.
- R03's exact fixed two-tool fixture is an initial connection/security test **only**. Shell and filesystem mutation are separate capabilities.
- Do not transform uncertain writes or process launches into automatic retries. On timeout after possible execution return an unknown outcome; require device-side receipt/status for any retry.
- WSL2 `/mnt/c` or interop/shell access is outside a simple pathname allowlist; no claim of OS containment.
- No production launch, GUI control, or Windows-native execution implied by R03 success.

## Minimal proposed deployment (partly accepted; concrete implementation UNAPPROVED)

```text
ChatGPT or compatible MCP client
   |
   | HTTPS, separate resource-bound OAuth (required; implementation undecided)
   v
one Remote Control MCP Worker (OAuthProvider + MCP /mcp)
   |-- OAuth persistence (implementation and store undecided)
   |-- narrow VPC Service binding to fixed adapter target
   |-- never forwards client token to device
   v
dedicated outbound cloudflared Tunnel
   v
Linux loopback HTTP adapter, separate per-device secret
   |-- double tool/arg/path validation
   |-- bounded payload/time/output; redact errors/logs
   |-- single locally-supervised pinned Desktop Commander stdio subprocess
   v
unprivileged Linux user or isolated workload (DECISION PENDING)
```

### Simplicity budget

- Candidate deployment: 1 new Worker, 1 local adapter + pinned stdio MCP package, 1 private Tunnel + one host/port VPC Service. OAuth persistence and authorization-server topology remain to be chosen.
- No D1/R2/DO/Queues/Workflows, dashboard, pairing flow, multi-device router, video GUI, unrestricted HTTP proxy, custom upstream execution engine, scheduled CI, or new reusable auth framework.
- MVP probe has no persistent process state. **If** remote Shell/writes are enabled, define minimal device-local operation receipts/idempotency and unknown-outcome handling before exposing those actions. `start_process` / `interact_with_process` / `kill_process` need independent policies.
- Combined one-Worker OAuth is a proposed simplification **different from** the uploaded Spec's split Auth Server/Resource Worker design; **independent OAuth is accepted, but combining or splitting the server is not yet accepted**.
- Pin upstream distribution including dependency audit, consider `get_config` read-only only after scrutiny, always deny `set_config_value` / config mutation / arbitrary process kill and unrestricted host paths by default.
- Linux-first implementation; WSL2 Ubuntu is an optional early test platform, not a product requirement. If the loopback VPC target is used, cloudflared and the adapter must be reachable in the same relevant network namespace (for containers, verify explicit host-loopback publication). Test Hosted VPC routing, Service registration, Host header and failure behavior with a disposable fixture.
- Compatibility acceptance separately verifies real ChatGPT/plugin connection and scope-dependent tool availability.

## Accepted Round 1 decision log — 2026-10-12

| ID | Agreed choice | Architecture record |
| --- | --- | --- |
| F1=A | Workspace file read/write, search, development Shell, managed processes; no host-wide administration | [ADR-0002](./adr/0002-v1-workspace-control-scope.md) |
| F2=A | Direct remote MCP clients through independent OAuth | [ADR-0003](./adr/0003-independent-oauth-for-direct-mcp-clients.md) |
| F3=A | No GUI, screen, mouse, keyboard or native Windows toolchain in v1 | [ADR-0002](./adr/0002-v1-workspace-control-scope.md) |
| F4=A | Strict Cloudflare VPC Service + private outbound Tunnel | [ADR-0004](./adr/0004-vpc-only-private-device-transport.md) |

## Round 2 decision frontier — PENDING USER ANSWERS

These three decisions can be discussed independently at the product policy level. Detailed file mounts, privilege profiles, TTLs, state implementation and stop/restart semantics are downstream and should wait.

**G1 — Execution isolation:**
- A (recommend): isolated Linux execution environment/container with only approved project directories mounted; no host PID/network namespace privilege, Docker socket or unnecessary host/Windows mounts. Any necessary dependency caches or package operations must be explicitly scoped.
- B: run a dedicated unprivileged Linux service user directly on the host, with OS permissions limiting the workspace; deployment is simpler but isolation from host resources and system services requires careful user/service restrictions.
- Risk: Desktop Commander `allowedDirectories` and `blockedCommands` are guardrails, **not** OS-level confinement, particularly for arbitrary Shell.

**G2 — Unattended-use requirement:**
- A (recommend): unattended execution is a v1 product requirement for permitted workspace operations, including approved classes of development Shell; outside agreed scope is rejected rather than silently executed or queued forever for impossible remote local approval. **Actual enablement requires the G1 confinement mechanism and later detailed command/file permission policy.**
- B: only read-only actions can be unattended; each write/Shell operation requires explicit local device confirmation.
- This chooses desired workflow, **not** yet an authorization policy or a guarantee that arbitrary Shell is safe.

**G3 — Failure recovery and replay policy:**
- A (recommend): each mutating operation/process launch uses an operation ID and a minimal durable local receipt written before dispatch. A timed-out/disconnected request with uncertain effect yields `unknown` or status query and must **not** automatically replay; only proven-not-started operations may be retried safely.
- B: stateless best-effort replies, with no persistent operation identity or device-side reconciliation; simple but loses confidence around repeat launches/writes after network failures.
- Even with option A, a crash between execution and receipt update may produce `unknown`. Exactly-once execution must **not** be promised without stronger proof and idempotent effects.

### Deferred decisions after G1–G3

- Exact read/write paths and mounts, whether project caches and credentials are available, and how Linux/WSL2 deployment differs.
- Which `start_process` arguments and interactive stdin need separate approval; per-class read/write/destructive policy; how to stop/kills only owned sessions.
- Operation receipt backend/retention/garbage collection, process crash recovery, cancellation and token revocation semantics.
- OAuth provider and topology, client registration, adapter authentication, real device/ChatGPT E2E acceptance, numerical limits and production budget.

**Do not implement or deploy until the frontier is exhausted and the user validates the final consensus.**

## Architecture review addendum — 2026-10-12 (NOT YET AN ADR)

- **Accepted in ADR-0001: Linux-first**. WSL2 is a Linux deployment variant, not a core architecture or protocol dependency. First supported platforms should be mainstream Linux distributions with Node runtime and cloudflared; WSL2 may be the first real-world test. Docker/VM are optional isolation profiles, not mandatory for all users. Do not embed `/mnt/c`, `wsl.exe`, Powershell or Windows paths in public MCP tools.
- **Do not claim our VPC design matches the proprietary hosted product.** The [Remote Desktop Commander README](https://github.com/desktop-commander/remote-desktop-commander) describes a hosted OAuth MCP service, device authorization/pairing and a managed relay; it does **not** disclose the hosted server's network transport or backend implementation. The self-hosted design instead uses published Cloudflare VPC Service + tunnel APIs and the upstream **local stdio MCP engine**, not the vendor's `remote` command.
- **Accepted in ADR-0004: private VPC-only routing**. VPC was consciously chosen over a publicly published Tunnel application, but it is not universally optimal. Cloudflare Workers VPC beta/pricing terms must be rechecked before launch. A public fallback is not permitted.
- **Accepted in ADR-0003: independent OAuth and direct MCP client ingress**. Resource audience, consent and scope validation are required; combining `OAuthProvider` and MCP in one Worker with its OAuth storage is still a **candidate**, not an accepted authorization-server design. Never reuse the shared `MCP_ACCESS_TOKEN` as a high-privilege remote execution credential.
- **A thin adapter is still justified** because the reusable open-source Desktop Commander engine speaks local stdio MCP, while the hosted vendor's remote agent requires its own proprietary service. Keep exactly one local authority for execution state and policy rather than creating competing cloud queues and sessions.
- **Shell/writes remain a separate design frontier.** If normal Linux user credentials have access to sensitive folders/SSH keys, app allowlists do not provide isolation. A container with narrowly defined mounts and no host Docker socket is a stronger default for unattended development work, but **not** a substitute for tool authorization, safe retry semantics and local secret hygiene.
- **Client compatibility and offline/timeout behavior must be measured**, including end-to-end availability of ChatGPT tool actions and whether the chosen transport supports realistic file/terminal outputs before promoting the R03 fixed read-only probe to a general product.
