# Remote Control MCP — research draft and grilling frontier

> Status: **Historical research and decision provenance; 2026-10-12 direction confirmed.** The authoritative formalized design is now [SPEC.md](./SPEC.md), pending final approval. Earlier [SPEC-DRAFT.md](./SPEC-DRAFT.md) and the original VPC-only R03 proposal are not concurrent implementation contracts; no implementation or deployment is authorized.
> This is not an implementation specification or deployment authorization. Accepted decisions live in linked ADRs; all uncited implementation patterns below remain proposals.
> Baseline: user-provided `Remote-Desktop-MCP-Spec-VPC-only(1).md` (R03 research contract, based on commit `e9764b73f9ce8894ccda6e4427bfd5ad3ee16fb5`). The old branch was not located in current branch search; the user's supplied copy is the source for that baseline.
> No existing production worker, secret, tunnel, or GitHub Actions workflow is changed.

## Settled decisions and records

- Product name: **Remote Control MCP**; proposed Worker/app id: `remote-control-mcp-worker`.
- Target execution model: **Linux-first** (WSL2 is a deployment variant, not a prerequisite).
- V1 file/search/Shell/managed-process categories and no GUI remain. Original workspace scoping (ADR-0002) was **superseded** by OS-user permission reach (ADR-0011); no root/admin privileges were approved.
- **Authentication accepted**: existing `@mcp-workers/portal-auth` static Bearer authentication and a separate high-entropy `MCP_ACCESS_TOKEN` **value** for Remote Control MCP. No OAuth provider or OAuth KV. The former OAuth ADRs 0003 and 0010 are superseded by [ADR-0012](./adr/0012-reuse-portal-bearer-auth-with-independent-secret.md).
- VPC-only private transport via exact VPC Service target and outbound Tunnel, no publicly published device endpoint or public fallback (F4=A). [ADR-0004](./adr/0004-vpc-only-private-device-transport.md).
- H1 curated tools (ADR-0008) and H2 managed sessions (ADR-0009) remain accepted. H3 OAuth topology (ADR-0010) is superseded by ADR-0012; the product still uses a single MCP Worker.
- Domain vocabulary: [CONTEXT.md](./CONTEXT.md); platform choice: [ADR-0001](./adr/0001-linux-first.md).
- G1 container isolation in ADR-0005 was **superseded by ADR-0011**; G2 unattended development and G3 local receipts/no blind replay remain, with wider OS-user filesystem reach.

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
   | HTTPS, MCP Portal Bearer auth (Remote Control-only token; ADR-0012)
   v
one Remote Control MCP Worker (/mcp, existing portal-auth validation)
   |-- MCP_ACCESS_TOKEN name; unique value for this Worker; no OAuth KV
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
Linux executor running as ordinary OS user; no container/path allowlist (ADR-0011)
```

### Simplicity budget

- Accepted minimal topology: one MCP Worker with existing Portal Bearer middleware, one local agent + pinned Desktop Commander stdio engine, one private Tunnel and one fixed VPC Service. The Remote Control Worker secret has a **different value** from the Database/IMA/Raindrop shared entry secret. No OAuth KV, GitHub OAuth app or separate auth Worker.
- No D1/R2/DO/Queues/Workflows, dashboard, pairing flow, multi-device router, video GUI, unrestricted HTTP proxy, custom upstream execution engine, scheduled CI, or new reusable auth framework.
- The original R03 **read-only fixture** has no persistent process state. V1 state-changing operations require minimal durable local receipts, operation IDs, status reconciliation and no blind retries (ADR-0007); concrete retention and process-session APIs remain to be defined.
- Earlier OAuth ADR-0010 is superseded by ADR-0012. The required client integration is the **existing MCP Portal Bearer path**, not generic OAuth client support. End-to-end compatibility must be proven; no unauthenticated fallback.
- Pin upstream distribution including dependency audit, consider `get_config` read-only only after scrutiny, always deny `set_config_value` / config mutation / arbitrary process kill and unrestricted host paths by default.
- Linux-first implementation; WSL2 Ubuntu is an optional early test platform, not a product requirement. If the loopback VPC target is used, cloudflared and the adapter must be reachable in the same relevant network namespace (for containers, verify explicit host-loopback publication). Test Hosted VPC routing, Service registration, Host header and failure behavior with a disposable fixture.
- Compatibility acceptance separately verifies real ChatGPT/plugin connection and scope-dependent tool availability.

## Accepted Round 1 decision log — 2026-10-12

| ID | Agreed choice | Architecture record |
| --- | --- | --- |
| F1=A (revised) | File/search/Shell/process types remain; project-root scoping superseded by Linux account reach | [ADR-0002](./adr/0002-v1-workspace-control-scope.md), [ADR-0011](./adr/0011-direct-linux-user-no-path-allowlist.md) |
| F2=A (superseded) | Original direct OAuth decision replaced by existing MCP Portal static Bearer with a separate Remote Control token value | [ADR-0012](./adr/0012-reuse-portal-bearer-auth-with-independent-secret.md) |
| F3=A | No GUI, screen, mouse, keyboard or native Windows toolchain in v1 | [ADR-0002](./adr/0002-v1-workspace-control-scope.md) |
| F4=A | Strict Cloudflare VPC Service + private outbound Tunnel | [ADR-0004](./adr/0004-vpc-only-private-device-transport.md) |

## Accepted Round 2 decision log — 2026-10-12

| ID | Agreed choice | Architecture record |
| --- | --- | --- |
| G1=A (superseded) | No container and no project-directory allowlist; Linux account permissions apply | [ADR-0011](./adr/0011-direct-linux-user-no-path-allowlist.md) |
| G2=A (revised reach) | Unattended development under ordinary Linux account permissions, not isolated project workspace | [ADR-0006](./adr/0006-unattended-authorized-workspace-operations.md), [ADR-0011](./adr/0011-direct-linux-user-no-path-allowlist.md) |
| G3=A | Stable operation ID + minimal durable device-side receipt before side effects; unknown outcome is not blindly retried | [ADR-0007](./adr/0007-local-receipts-and-no-blind-replay.md) |

Direct ordinary Linux-account execution is now accepted in ADR-0011; root privilege escalation, unrelated process management and blind mutation retry are not approved.

## Accepted Round 3 decision log — 2026-10-12

| ID | Agreed choice | Architecture record |
| --- | --- | --- |
| H1=A | Explicit, curated client-visible tools; no automatic upstream catalogue exposure | [ADR-0008](./adr/0008-curated-mcp-tool-surface.md) |
| H2=A | Owned development sessions may outlive tool requests, with local state/output/status/stop; no ambiguous relaunch | [ADR-0009](./adr/0009-owned-managed-process-sessions.md) |
| H3=A (superseded) | No OAuth provider needed; one MCP Worker validates Portal Bearer, with no OAuth KV | [ADR-0012](./adr/0012-reuse-portal-bearer-auth-with-independent-secret.md) |

H3 was confirmed separately, after a plain-language explanation. The combined OAuth Worker is **not** approval of a homegrown OAuth implementation.

## Operator revision: simplify host access and ingress — 2026-10-12

- **Accepted**: no Docker or container isolation and no project directory allowlist. Files and commands use the Linux Agent account's ordinary OS permissions, not a repository allowlist. This explicitly supersedes the previous G1/ADR-0005 decision; see [ADR-0011](./adr/0011-direct-linux-user-no-path-allowlist.md).
- **Retained**: Linux-first, no GUI, curated file/search/Shell/managed-session tools, unattended operation goal, local receipts, no blind retries, one-device private VPC Service + Tunnel.
- **Accepted after explicit confirmation**: existing Portal Bearer replaces GitHub/direct OAuth. Current `main` has `packages/portal-auth/src/index.ts` which validates `Authorization: Bearer` against `MCP_ACCESS_TOKEN`. Reuse the middleware and secret **name**, but never the token **value** shared by the other three MCP Workers.
- **Compatibility gate (mandatory)**: a standalone ChatGPT custom-plugin direct connector is not assumed to allow manual static Bearer input. Verify the existing MCP Portal route really forwards the separate Bearer token through actual ChatGPT initialization, tool discovery and a safe read-only call. Deny bad/missing Bearer and do not enable Shell if the path fails. Do not deploy anonymous remote Shell.
- **K1 settled**: existing Portal Bearer with a different high-entropy secret (ADR-0012). ADR-0003 and ADR-0010 are historical/superseded. Direct standards-based OAuth access is not promised in v1.
- **Runtime account settled**: the operator explicitly chose the **existing ordinary Linux login user**, not a dedicated account. Inspect its real sudo/container-runtime/credential permissions before activating unattended Shell. Remaining spec details: exact tool schemas/limits, local receipt cleanup and session restart/stop behavior. Avoid new workflows or complex infrastructure.

## Read-only acceptance gate before remote Shell

The user has selected a **simple auth mechanism**, but the tool's presence in ChatGPT does not on its own prove the selected Portal route can send a static Bearer to this new Worker.

1. Check only the required secret **name** `MCP_ACCESS_TOKEN` in the new Worker configuration. Provision a new **value** through runtime secrets outside Git, never copy the existing three-app value or paste it into logs.
2. Check the real Portal configuration can connect to `/mcp` with this value and can initialize, list the curated tools and call one safe read-only fixture in a controlled test environment.
3. Confirm missing/wrong credentials fail closed before MCP handler or any device request. No fallback public/anonymous endpoint.
4. Confirm the Worker uses a separate device/adapter secret, never forwards the Portal Bearer to the device, and has only a fixed VPC Service host/port target.
5. Only after separate local authorization and Linux-account-risk acceptance, test writable tools/Shell. Confirm no root escalation and explain that user-readable secrets are in scope without container/path isolation.
6. On network failure after writes/process starts, local receipts/unknown outcome protect against blind duplicate execution.

This is a **verification plan**, not an already successful E2E test or permission to create cloud resources.

## Architecture review addendum — 2026-10-12 (NOT YET AN ADR)

- **ADR-0001/0011: Linux-first as the operator's existing ordinary Linux login user**, without containers or application project-root restrictions. WSL2 remains a deployment variant. Actual privilege pathways still need inspection, not guessing.
- **Do not claim our VPC design matches the proprietary hosted product.** The [Remote Desktop Commander README](https://github.com/desktop-commander/remote-desktop-commander) describes a hosted OAuth MCP service, device authorization/pairing and a managed relay; it does **not** disclose the hosted server's network transport or backend implementation. The self-hosted design instead uses published Cloudflare VPC Service + tunnel APIs and the upstream **local stdio MCP engine**, not the vendor's `remote` command.
- **Accepted in ADR-0004: private VPC-only routing**. VPC was consciously chosen over a publicly published Tunnel application, but it is not universally optimal. Cloudflare Workers VPC beta/pricing terms must be rechecked before launch. A public fallback is not permitted.
- **Authentication accepted in ADR-0012: static Portal Bearer**, replacing OAuth ADR-0003/0010. Confirm actual Portal-to-ChatGPT delivery and valid/invalid token behavior before enabling remote writes or Shell. Never share the three-app token value; never allow anonymous MCP Shell.
- **A thin adapter is still justified** because the reusable open-source Desktop Commander engine speaks local stdio MCP, while the hosted vendor's remote agent requires its own proprietary service. Keep exactly one local authority for execution state and policy rather than creating competing cloud queues and sessions.
- **ADR-0011 + ADR-0006/0007**: no container/path sandbox; unattended curated tools and minimal local receipts remain. Remote Shell can access Linux-account-accessible secrets, so review privileged account selection and token theft risk.
- **Client compatibility and offline/timeout behavior must be measured**, including end-to-end availability of ChatGPT tool actions and whether the chosen transport supports realistic file/terminal outputs before promoting the R03 fixed read-only probe to a general product.
