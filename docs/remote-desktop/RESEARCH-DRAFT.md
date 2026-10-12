# Remote Desktop MCP — research draft and grilling frontier

> Status: **Research / UNAPPROVED proposal** (2026-10-12).
> This is not an implementation specification, authorization to deploy, or a settled ADR.
> Baseline: user-provided `Remote-Desktop-MCP-Spec-VPC-only(1).md` (R03 research contract, based on commit `e9764b73f9ce8894ccda6e4427bfd5ad3ee16fb5`). The old branch was not located in current branch search; the user's supplied copy is the source for that baseline.
> No existing production worker, secret, tunnel, or GitHub Actions workflow is changed.

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
one Remote Desktop MCP Worker (OAuthProvider + MCP /mcp)
   |-- one OAUTH_KV namespace (OAuth grants only)
   |-- narrow VPC Service binding to fixed adapter target
   |-- never forwards client token to device
   v
dedicated outbound cloudflared Tunnel
   v
WSL2 loopback HTTP adapter, separate per-device secret
   |-- double tool/arg/path validation
   |-- bounded payload/time/output; redact errors/logs
   |-- single locally-supervised pinned Desktop Commander stdio subprocess
   v
ordinary WSL2 user or isolated workload (DECISION PENDING)
```

### Simplicity budget

- 1 new Worker, 1 local adapter + existing pinned stdio MCP package, 1 Tunnel + one host/port VPC Service, 1 OAuth KV only if direct client OAuth chosen.
- No D1/R2/DO/Queues/Workflows, dashboard, pairing flow, multi-device router, video GUI, unrestricted HTTP proxy, custom upstream execution engine, scheduled CI, or new reusable auth framework.
- MVP probe has no persistent process state. **If** remote Shell/writes are enabled, define minimal device-local operation receipts/idempotency and unknown-outcome handling before exposing those actions. `start_process` / `interact_with_process` / `kill_process` need independent policies.
- If one-Worker OAuth is chosen, that is an explicit proposed simplification **different from** the uploaded Spec's split Auth Server/Resource Worker design, not an already approved decision.
- Pin upstream distribution including dependency audit, consider `get_config` read-only only after scrutiny, always deny `set_config_value` / config mutation / arbitrary process kill and unrestricted host paths by default.
- Start on WSL2 with cloudflared and adapter in the same relevant network namespace if a loopback VPC target is used; test Hosted VPC routing, Service registration, Host header and failure behavior with a disposable fixture.
- Compatibility acceptance separately verifies real ChatGPT/plugin connection and scope-dependent tool availability.

## Unresolved decision frontier — Round 1

**Q1 — target operational capabilities:** recommend workspace-scoped read + write + development Shell (after read-only probe), not automatic whole-machine administration. Does the product need full WSL/Windows host control at launch?

**Q2 — OS privilege boundary:** recommend isolated workspace/container with only approved project mounts, no Docker socket/privileged mode/host PID/Windows mounts, unless host administration is the explicit goal. Is an ordinary WSL account (with local approvals for privileged actions) a requirement?

**Q3 — client authentication:** recommend direct ChatGPT-compatible OAuth with one Worker + OAuth KV and one dedicated GitHub OAuth identity source; avoid reusing the shared `MCP_ACCESS_TOKEN`. This differs from split Auth/Resource of old Spec. Is direct ChatGPT/other external client connection the intended ingress, or must the existing MCP Portal be the sole entry?

**Q4 — remote unattended use:** recommend unattended commands **only inside isolated, preapproved workspace scope**; host-wide and destructive actions remain denied rather than pending an unavailable on-device click. Is local interactive approval acceptable/available when the user is away?

**Q5 — scope of 'desktop':** recommend WSL2 files/terminal/processes only, no Windows desktop screen/mouse/keyboard or Windows-native PowerShell in v1. Are GUI and native Windows operations required?

Do not create ADRs until the corresponding user decisions are explicit. Once settled, write an app-local CONTEXT.md and a minimal ADR only for hard-to-reverse transport/privilege/auth choices. Existing `main` is untouched.
