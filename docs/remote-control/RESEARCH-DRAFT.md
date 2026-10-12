# Remote Control MCP — research draft and grilling frontier

> Status: **Research draft; Round 1 F1–F4, Round 2 G1–G3 and Round 3 H1–H3 all accepted** on 2026-10-12. Identity provider, workspace/secret/network policy, process restart semantics, detailed tool contracts, budgets and rollout are NOT yet accepted.
> This is not an implementation specification or deployment authorization. Accepted decisions live in linked ADRs; all uncited implementation patterns below remain proposals.
> Baseline: user-provided `Remote-Desktop-MCP-Spec-VPC-only(1).md` (R03 research contract, based on commit `e9764b73f9ce8894ccda6e4427bfd5ad3ee16fb5`). The old branch was not located in current branch search; the user's supplied copy is the source for that baseline.
> No existing production worker, secret, tunnel, or GitHub Actions workflow is changed.

## Settled decisions and records

- Product name: **Remote Control MCP**; proposed Worker/app id: `remote-control-mcp-worker`.
- Target execution model: **Linux-first** (WSL2 is a deployment variant, not a prerequisite).
- Accepted v1 feature contract (F1=A and F3=A): workspace file read/write, search, development Shell and managed processes; no host-wide administration, GUI/screen/mouse/keyboard or native Windows in v1. [ADR-0002](./adr/0002-v1-workspace-control-scope.md).
- Independent OAuth and directly connectable remote MCP clients (F2=A); existing shared `MCP_ACCESS_TOKEN` must not grant local host control. [ADR-0003](./adr/0003-independent-oauth-for-direct-mcp-clients.md).
- VPC-only private transport via exact VPC Service target and outbound Tunnel, no publicly published device endpoint or public fallback (F4=A). [ADR-0004](./adr/0004-vpc-only-private-device-transport.md).
- Curated tool surface (H1=A) [ADR-0008](./adr/0008-curated-mcp-tool-surface.md), long-running owned process sessions (H2=A) [ADR-0009](./adr/0009-owned-managed-process-sessions.md), and combined OAuth+MCP single Worker (H3=A) [ADR-0010](./adr/0010-single-worker-oauth-and-mcp.md) are accepted. The specific identity provider, framework/version and user allowlist remain undecided.
- Domain vocabulary: [CONTEXT.md](./CONTEXT.md); platform choice: [ADR-0001](./adr/0001-linux-first.md).
- Round 2 accepted **isolated containerized workspace execution** [ADR-0005](./adr/0005-isolated-workspace-execution.md), **unattended authorized workspace operations** [ADR-0006](./adr/0006-unattended-authorized-workspace-operations.md), and **minimal local operation receipts with no blind replay** [ADR-0007](./adr/0007-local-receipts-and-no-blind-replay.md). Tool-level policy and session/receipt details remain undecided.

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
   | HTTPS, independent resource-bound OAuth (user identity pending)
   v
one Remote Control MCP Worker (combined OAuth + MCP /mcp, ADR-0010)
   |-- provider-required OAuth grant store (candidate OAUTH_KV)
   |-- narrow VPC Service binding to fixed adapter target
   |-- never forwards client token to device
   v
dedicated outbound cloudflared Tunnel
   v
Linux loopback HTTP adapter, separate per-device secret
   |-- double tool/arg/path validation
   |-- bounded payload/time/output; redact errors/logs
   |-- minimal local operation receipts before side effects (ADR-0007)
   |-- single locally-supervised pinned Desktop Commander stdio subprocess
   v
isolated Linux workspace executor (ADR-0005; exact mounts pending)
```

### Simplicity budget

- Accepted minimal topology: 1 combined OAuth+MCP Worker, a provider-required OAuth grant store (the reviewed Cloudflare library uses OAUTH_KV), 1 local adapter + pinned stdio MCP package, 1 private Tunnel + 1 fixed VPC Service host/port. Concrete package version, provider and deployment details remain to be chosen.
- No D1/R2/DO/Queues/Workflows, dashboard, pairing flow, multi-device router, video GUI, unrestricted HTTP proxy, custom upstream execution engine, scheduled CI, or new reusable auth framework.
- The original R03 **read-only fixture** has no persistent process state. V1 state-changing operations require minimal durable local receipts, operation IDs, status reconciliation and no blind retries (ADR-0007); concrete retention and process-session APIs remain to be defined.
- Combined one-Worker OAuth is **accepted in ADR-0010**; this intentionally differs from the uploaded Spec's split Auth Server/Resource Worker proposal. Official Cloudflare Workers OAuth Provider supports single Worker alongside its generally recommended split model; do not confuse acceptance of topology with selection of a specific SDK version or login provider.
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

## Accepted Round 2 decision log — 2026-10-12

| ID | Agreed choice | Architecture record |
| --- | --- | --- |
| G1=A | Containerized isolated Linux execution, mount only authorized workspace resources; no broad host/container runtime privileges | [ADR-0005](./adr/0005-isolated-workspace-execution.md) |
| G2=A | Unattended execution of explicitly permitted workspace writes/development Shell; out-of-scope operations are rejected | [ADR-0006](./adr/0006-unattended-authorized-workspace-operations.md) |
| G3=A | Stable operation ID + minimal durable device-side receipt before side effects; unknown outcome is not blindly retried | [ADR-0007](./adr/0007-local-receipts-and-no-blind-replay.md) |

No direct host account execution, unconditional tool escalation, universal per-call local confirmation, or stateless mutation replay is approved.

## Accepted Round 3 decision log — 2026-10-12

| ID | Agreed choice | Architecture record |
| --- | --- | --- |
| H1=A | Explicit, curated client-visible tools; no automatic upstream catalogue exposure | [ADR-0008](./adr/0008-curated-mcp-tool-surface.md) |
| H2=A | Owned development sessions may outlive tool requests, with local state/output/status/stop; no ambiguous relaunch | [ADR-0009](./adr/0009-owned-managed-process-sessions.md) |
| H3=A | One Cloudflare Worker combines independent OAuth authorization endpoints and the MCP resource | [ADR-0010](./adr/0010-single-worker-oauth-and-mcp.md) |

H3 was confirmed separately, after a plain-language explanation. The combined OAuth Worker is **not** approval of a homegrown OAuth implementation.

## Round 4 decision frontier — PENDING USER ANSWERS

The following decisions are independent given the accepted first three rounds. All listed A choices are **recommendations only**, not accepted until the user answers.

**J1 — Single-user identity source:**
- A (recommend): authenticate the owner through a dedicated GitHub OAuth application and allowlist the **immutable GitHub numeric account ID**. No other GitHub account gets access solely because it signed in. Maintain distinct Remote Control MCP OAuth tokens/grants.
- B: choose a different login provider or an independent access portal/identity service. This may better fit enterprise/SSO environments but adds a new product dependency. The exact provider must then be specified.
- Protect OAuth redirects, state, PKCE, audience, scopes and revocation regardless; the final client/provider integration requires a live end-to-end test.

**J2 — Authorized workspace count:**
- A (recommend): one explicitly configured project root mounted read/write per deployed Linux Agent. To change project, update the authorized mount/configuration; never mount the whole home directory by default.
- B: allow several separately listed project roots mounted and selectable concurrently, each explicitly configured with its own scope. More convenient for multi-repository work but increases policy and mount configuration.
- Both must exclude unrelated host directories, symlink escapes, host container runtime control, and unwanted host/Windows mounts. The project root does not grant access to external secrets.

**J3 — Workspace runtime network policy:**
- A (recommend): outbound network is available for ordinary development fetches (package registries, Git hosting) subject to enforceable controls against access to host/private services and cloud metadata. Do not inject host credentials or expose the Docker socket. The exact network controls must be proven before production; if a safe policy cannot be enforced, fail closed rather than claiming safety.
- B: execution environment has no outbound network by default; dependency downloads or remote Git operations require separate explicitly approved arrangements.
- This question only decides the product's required network reach, not a specific firewall/namespace implementation.

**J4 — Managed sessions across device/container restart:**
- A (recommend): long-running processes survive an individual MCP request but **are not promised to survive a Linux Agent or container restart**. After restart, reconcile and mark former sessions stopped/stale/unknown; do not automatically re-launch them.
- B: support explicitly registered persistent development services and their restart policy across a container or Agent restart. Requires additional lifecycle/state and avoids blind restart only with separately verified service identity.
- Both preserve the accepted no-blind-replay invariant from ADR-0007.

### Implementation details to settle or derive after J1–J4

- Exact upstream tool names/schemas, create/overwrite/delete and `start_process` / stdin policy; prompt injection and potentially destructive workspace Shell remain within the isolated workspace risk model.
- Workdir/mount ownership, non-root user, dependency caches, environment variable policy and container lifecycle.
- OAuth grant storage, owner identity binding, consent/client registration/refresh and device credential rotation; proof in ChatGPT and another supported client.
- Local receipt retention, output limits, process group termination, log redaction, interruption, stop/cancel semantics and host/private network deny tests.
- Fixed VPC Service host/port and Tunnel namespace, fail-closed offline behavior, configuration budget and rollback. Avoid inventing new CI workflows.

**No feature code or production deployment before the user validates a consolidated final design.**

## Architecture review addendum — 2026-10-12 (NOT YET AN ADR)

- **Accepted in ADR-0001 and ADR-0005: Linux-first + isolated execution**. WSL2 is a deployment variant, not a core protocol requirement; v1 workspace execution is container-isolated. Whether the agent/adapter is deployed on the host or inside the container is still undecided. Do not embed `/mnt/c`, `wsl.exe`, PowerShell or Windows paths in the tool contract.
- **Do not claim our VPC design matches the proprietary hosted product.** The [Remote Desktop Commander README](https://github.com/desktop-commander/remote-desktop-commander) describes a hosted OAuth MCP service, device authorization/pairing and a managed relay; it does **not** disclose the hosted server's network transport or backend implementation. The self-hosted design instead uses published Cloudflare VPC Service + tunnel APIs and the upstream **local stdio MCP engine**, not the vendor's `remote` command.
- **Accepted in ADR-0004: private VPC-only routing**. VPC was consciously chosen over a publicly published Tunnel application, but it is not universally optimal. Cloudflare Workers VPC beta/pricing terms must be rechecked before launch. A public fallback is not permitted.
- **Accepted in ADR-0003/0010: independent OAuth, direct MCP client ingress and one combined Worker**. Cloudflare's OAuth Provider supports the combined shape, although its current README recommends split roles more generally. An upstream login provider, owner allowlist, OAuth storage/version and client compatibility are not yet decided. Never reuse the shared `MCP_ACCESS_TOKEN` as a high-privilege remote execution credential.
- **A thin adapter is still justified** because the reusable open-source Desktop Commander engine speaks local stdio MCP, while the hosted vendor's remote agent requires its own proprietary service. Keep exactly one local authority for execution state and policy rather than creating competing cloud queues and sessions.
- **Accepted in ADR-0005/0006/0007: workspace isolation, unattended authorized operations and local receipts**. Filesystem allowlists cannot sandbox Shell. Even in a container, tool/argument policy, secrets and egress protection, session stopping and unambiguous retry behavior require specific implementation/acceptance decisions.
- **Client compatibility and offline/timeout behavior must be measured**, including end-to-end availability of ChatGPT tool actions and whether the chosen transport supports realistic file/terminal outputs before promoting the R03 fixed read-only probe to a general product.
