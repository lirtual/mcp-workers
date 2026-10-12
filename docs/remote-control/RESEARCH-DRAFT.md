# Remote Control MCP — research draft and grilling frontier

> Status: **Research / UNAPPROVED implementation proposal** (2026-10-12). Product name and Linux-first direction are accepted; execution scope, authentication, isolation, and rollout are not.
> This is not an implementation specification, authorization to deploy, or a settled ADR.
> Baseline: user-provided `Remote-Desktop-MCP-Spec-VPC-only(1).md` (R03 research contract, based on commit `e9764b73f9ce8894ccda6e4427bfd5ad3ee16fb5`). The old branch was not located in current branch search; the user's supplied copy is the source for that baseline.
> No existing production worker, secret, tunnel, or GitHub Actions workflow is changed.

## Settled decisions and records

- Product name: **Remote Control MCP**; proposed Worker/app id: `remote-control-mcp-worker`.
- Target execution model: **Linux-first** (WSL2 is a deployment variant, not a prerequisite).
- Domain vocabulary: [CONTEXT.md](./CONTEXT.md); accepted platform ADR: [0001-linux-first.md](./adr/0001-linux-first.md).
- No other architecture or security choices are deemed settled by these decisions.

## Evidence and source boundaries

1. [Remote Desktop Commander public repository](https://github.com/desktop-commander/remote-desktop-commander): hosted OAuth + device pairing + relay; hosted backend is proprietary, public repo holds docs/manifests. Its `npx @wonderwhy-er/desktop-commander@latest remote` joins the vendor-hosted device service; it is **not** the command for self-hosted VPC execution.
2. [DesktopCommanderMCP](https://github.com/wonderwhy-er/DesktopCommanderMCP): MIT local stdio MCP engine. The reviewed `package.json` currently specifies `0.2.52`; pin and verify an exact distribution/integrity before deployment, never use `@latest` in production. The repository includes file read/write, search, terminal, sessions/processes, configuration changes and document capabilities.
3. [Upstream security model](https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/main/SECURITY.md): allowed directories, command blocklists, and symlink checks are guardrails, **not a shell sandbox**. Use an isolated OS user/container/VM if containment is required.
4. [Cloudflare Workers VPC Services](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/) and [bindings API](https://developers.cloudflare.com/workers-vpc/api/): bind one exact host:port over a private tunnel; a VPC Service's target controls routing rather than the Host supplied to `fetch()`. Beta/free status is subject to change.
5. [Cloudflare Workers OAuth Provider v1](https://github.com/cloudflare/workers-oauth-provider): for **one resource and one person**, its one-Worker `OAuthProvider` is supported (in addition to separate auth/resource Workers); KV `OAUTH_KV` is necessary. GitHub identity, actual consent, redirect protections, token/resource audience and PKCE must be verified.
6. [MCP 2026-07-28 auth specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization): latest researched published auth guidance, differing from the original R03 probe's locked `2025-11-25` protocol. Negotiate/test protocol and client compatibility instead of blindly hardcoding the legacy probe version.
7. [ChatGPT custom MCP plugin guidance](https://developers.openai.com/api/docs/guides/custom-mcp-server): OAuth supported; client registration/discovery, tool invocation rights, and actual account availability require end-to-end testing.
8. Current `mcp-workers/main` contains only `apps/database-mcp-worker`, `apps/ima-mcp-worker`, and `apps/raindrop-mcp-worker`. Its `MCP_ACCESS_TOKEN` is shared across those three; extending that same value to a high-risk remote Shell worker would increase blast radius. Existing `portal-auth` can provide conventions, not automatic authorization for host access.

## Original VPC-only requirements to preserve unless consciously revised

- VPC Service (not VPC Network), private cloudflared tunnel, no public origin listener and no user-selected downstream host/port.
- Outer client auth, separate device auth, and device-side tool/argument/path policy are separate checks. No OAuth bearer forwarding to device.
- R03's exact fixed two-tool fixture is an initial connection/security test **only**. Shell and filesystem mutation are separate capabilities.
- Do not transform uncertain writes or process launches into automatic retries. On timeout after possible execution return an unknown outcome; require device-side receipt/status for any retry.
- WSL2 `/mnt/c` or interop/shell access is outside a simple pathname allowlist; no claim of OS containment.
- No production launch, GUI control, or Windows-native execution implied by R03 success.

## Minimal proposed deployment (UNAPPROVED)

```text
ChatGPT or compatible MCP client
   |
   | HTTPS, resource-bound OAuth
   v
one Remote Control MCP Worker (OAuthProvider + MCP /mcp)
   |-- one OAUTH_KV namespace (OAuth grants only)
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

- 1 new Worker, 1 local adapter + existing pinned stdio MCP package, 1 Tunnel + one host/port VPC Service, 1 OAuth KV only if direct client OAuth chosen.
- No D1/R2/DO/Queues/Workflows, dashboard, pairing flow, multi-device router, video GUI, unrestricted HTTP proxy, custom upstream execution engine, scheduled CI, or new reusable auth framework.
- MVP probe has no persistent process state. **If** remote Shell/writes are enabled, define minimal device-local operation receipts/idempotency and unknown-outcome handling before exposing those actions. `start_process` / `interact_with_process` / `kill_process` need independent policies.
- If one-Worker OAuth is chosen, that is an explicit proposed simplification **different from** the uploaded Spec's split Auth Server/Resource Worker design, not an already approved decision.
- Pin upstream distribution including dependency audit, consider `get_config` read-only only after scrutiny, always deny `set_config_value` / config mutation / arbitrary process kill and unrestricted host paths by default.
- Linux-first implementation; WSL2 Ubuntu is an optional early test platform, not a product requirement. If the loopback VPC target is used, cloudflared and the adapter must be reachable in the same relevant network namespace (for containers, verify explicit host-loopback publication). Test Hosted VPC routing, Service registration, Host header and failure behavior with a disposable fixture.
- Compatibility acceptance separately verifies real ChatGPT/plugin connection and scope-dependent tool availability.

## Unresolved decision frontier — Round 1 (independent choices)

**F1 — initial product scope:** Option A (recommended): workspace-scoped Linux file read/write, search, development Shell and managed process sessions; no host-wide administration. Option B: Linux host administration also required, including system configuration and privileged operations. The choice governs execution privilege, approvals, containment and operation receipts.

**F2 — external client ingress:** Option A (recommended): direct ChatGPT/compatible remote MCP clients via an independent OAuth-protected Worker; never share the existing high-blast-radius `MCP_ACCESS_TOKEN`. Option B: use only the existing MCP Portal with separately validated client authorization and dedicated device authorization. The choice governs OAuth server, state and onboarding.

**F3 — GUI scope:** Option A (recommended): Linux file, terminal and process operations only for v1. Option B: include Linux graphical desktop/screen/mouse/keyboard control in v1, which needs a different execution and streaming subsystem. Do not call the product "remote desktop" in either case.

**F4 — networking contract:** Option A (recommended): retain strict private Cloudflare VPC Service + dedicated Tunnel (the prior research baseline). Option B: explicitly reconsider a simpler published Tunnel application with additional authorization and a different public attack surface. This question addresses whether the **VPC-only** label is a binding product requirement.

### Questions deliberately deferred until scope is resolved

- Constrained container vs non-privileged Linux system account; actual file mounts and secrets.
- Unattended vs per-operation local authorization; which actions can run without someone at the host.
- Safe side effects and unknown outcome: local receipts, process recovery, retries, bounded output and cancel/stop.
- Which tools to surface from pinned local Desktop Commander and whether their shape is compatible with real ChatGPT app permissions.
- Accepted registration, deployment and cost envelope after the OAuth/VPC topology is chosen.

**None of the Round 1 recommendations are user-approved yet.** Proceed to Round 2 only after the user answers Round 1; record accepted terms and ADRs as each decision settles.

## Architecture review addendum — 2026-10-12 (NOT YET AN ADR)

- **Recommendation: Linux-first**. WSL2 is a Linux deployment variant, not a core architecture or protocol dependency. First supported platforms should be mainstream Linux distributions with Node runtime and cloudflared; WSL2 may be the first real-world test. Docker/VM are optional isolation profiles, not mandatory for all users. Do not embed `/mnt/c`, `wsl.exe`, Powershell or Windows paths in public MCP tools.
- **Do not claim our VPC design matches the proprietary hosted product.** The [Remote Desktop Commander README](https://github.com/desktop-commander/remote-desktop-commander) describes a hosted OAuth MCP service, device authorization/pairing and a managed relay; it does **not** disclose the hosted server's network transport or backend implementation. The self-hosted design instead uses published Cloudflare VPC Service + tunnel APIs and the upstream **local stdio MCP engine**, not the vendor's `remote` command.
- **VPC vs simpler published tunnel is a tradeoff, not universally optimal.** Given the user-supplied VPC-only requirement, one fixed-host/port VPC Service is the preferred private bridge. Cloudflare Workers VPC remains beta and beta pricing is not a contractual permanent guarantee. A publicly published Tunnel application is not a fallback unless the VPC-only requirement is explicitly revised.
- **OAuth is conditional on the actual entrypoint.** For direct third-party MCP client interoperability, use a compliant resource-bound OAuth flow and the supported combined `OAuthProvider` in one Worker (requires `OAUTH_KV`). For ingress solely through an existing authenticated Portal, evaluate its full effective auth model, including client identity and ability to use remote tools, before deciding whether additional OAuth is necessary. Never reuse the shared `MCP_ACCESS_TOKEN` as a high-privilege remote execution credential. Authentication choice remains UNDECIDED.
- **A thin adapter is still justified** because the reusable open-source Desktop Commander engine speaks local stdio MCP, while the hosted vendor's remote agent requires its own proprietary service. Keep exactly one local authority for execution state and policy rather than creating competing cloud queues and sessions.
- **Shell/writes remain a separate design frontier.** If normal Linux user credentials have access to sensitive folders/SSH keys, app allowlists do not provide isolation. A container with narrowly defined mounts and no host Docker socket is a stronger default for unattended development work, but **not** a substitute for tool authorization, safe retry semantics and local secret hygiene.
- **Client compatibility and offline/timeout behavior must be measured**, including end-to-end availability of ChatGPT tool actions and whether the chosen transport supports realistic file/terminal outputs before promoting the R03 fixed read-only probe to a general product.
