# EdgeSSH MCP — Grilling with Docs · Round 1

Status: **research / proposed defaults only — NOT APPROVED**
Date: 2026-10-17
Source repos: [EdgeSSH](https://github.com/lirtual/EdgeSSH) and [mcp-workers](https://github.com/lirtual/mcp-workers).

This is a design-interview record, **not a specification or an ADR**. Every recommendation below is a proposal pending explicit operator decisions. This PR changes documentation only: no live Worker, credential, authentication or runtime behavior.

## What repository reconnaissance established

- EdgeSSH is a standalone, single-admin WebSSH workspace with host records and encrypted SSH credentials in its own account data. Its browser API includes a privileged credentials-returning route; that existing browser route is **not** an acceptable MCP integration API.
- EdgeSSH handles the TCP connection and SSH protocol through Workers, Durable Objects and WebSocket-oriented `SSHSession`. The existing protocol supports SSH exec for specific system/process operations but **does not expose a ready-made, bounded, headless MCP command API**.
- Host metadata can include previously stored system information; that data is a **snapshot**, not live health.
- Host identity is verified using a pinned SSH fingerprint or interactive confirmation. Unattended MCP access cannot silently accept an unknown or changed host fingerprint.
- EdgeSSH currently supports public SSH targets; the proposed integration does not make it a general connector for private/LAN-only hosts.
- The `mcp-workers` repository's [architecture spec](../mcp-workers-spec.md) keeps each MCP app independent, with its own Worker, credentials and deployment. Its existing `portal-auth` component supports Bearer authentication for the MCP Portal, not an OAuth provider.
- In the operator's currently connected Cloudflare account both `edgessh` and existing MCP Workers are deployed. That establishes feasibility for a **same-account** Service Binding integration, but does not generalize to users deploying in separate accounts.
- Cloudflare Service Bindings support private Worker-to-Worker RPC, including named entrypoints, **within one account**; Access user context is **not propagated automatically**. See the official [RPC](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/) and [bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/) docs.

## Candidate architecture (NOT APPROVED)

```text
AI / MCP Client
     |
MCP Portal -> apps/edgessh-mcp-worker   (MCP ingress and tool schema)
     |
     | same-account Service Binding (no SSH secrets in the caller)
     v
EdgeSSH Worker / opt-in internal RPC entrypoint
     |       existing host storage + credential ownership
     |       target authorization + host fingerprint validation
     v
SSH connection/session machinery -> SSH server
```

- EdgeSSH remains a usable independent browser application with unchanged public HTTP routes.
- The MCP adapter remains a separate independently deployed app inside `mcp-workers`.
- Only the EdgeSSH owner may decrypt stored SSH credentials; the MCP adapter receives sanitized results, not decrypted credentials or encryption keys.
- Any RPC method must enforce target and operation policy within EdgeSSH, not rely on prompt text or tool annotations for safety.
- For live operations, first establish a narrow, bounded headless SSH execution seam; do **not** simulate an interactive browser WebSocket to issue commands.
- Per-call bounded operations and cleanup are preferable to background SSH session orchestration unless an actual requirement proves otherwise.

## Design hazards / failure tests (research conclusions, not product choices)

1. **Cross-account deployment**: same-account Service Binding does not directly address cross-account installs. Do not silently expose credential-bearing public SSH APIs to solve this.
2. **Credential leak**: existing `/api/hosts/:id/credentials` is for authenticated browser workflows. Never forward its plaintext response via MCP; never copy EdgeSSH's encryption key or duplicate D1 credential storage.
3. **Confused deputy**: a valid MCP Bearer alone is not authority for every saved SSH host. Require enforceable host and operation policy on the EdgeSSH side.
4. **Host-key trust**: reject or require human pre-enrollment for unknown/changed host fingerprints. AI cannot auto-confirm key changes.
5. **"Read-only" command illusion**: arbitrary shell commands, including those that appear informational, may mutate state or disclose secrets. Server-defined diagnostics are different from arbitrary `exec(command)`.
6. **WebSocket entanglement**: browser-specific session assumptions may make headless execution more expensive than expected. Feasibility must be proven against production-equivalent protocol code in tests before committing to live operations.
7. **Outcome bounds**: enforce timeout, response-size cap, concurrency cap and cleanup on all live operations; distinguish cached data, fresh data and failed attempts.
8. **Deploy isolation**: adding an MCP adapter must not make base EdgeSSH require it to start or deploy. Invalid/missing integration configuration must not disable the normal WebSSH app.
9. **Permissions**: an internal RPC binding authorizes calling that entrypoint; it does not propagate human identity or magically enforce per-host rights.
10. **No speculative platform**: do not build a common SSH SDK, replicated host database, second credential vault, long-running execution queue, general OAuth service, central orchestrator, or remote-control bridge merely for this integration.

## First decision frontier — user answers required

**Q1 · Audience / deployment topology**
- A (recommended): v1 targets operator-controlled **same-account** EdgeSSH + MCP Worker only; no cross-account gateway.
- B: v1 must support arbitrary, cross-account independently deployed EdgeSSH installations (requires a separate authenticated public interface and deployment model).

**Q2 · Minimum useful MCP capability**
- A (recommended): host discovery plus a few fixed, bounded **live read-only diagnostic operations** (no arbitrary Shell and no file mutation). First probe existing headless SSH feasibility; if costly, release metadata-only technical slice without misrepresenting it as full SSH diagnostics.
- B: initial release requires unrestricted or parameterized command execution and SFTP modifications.
- C: initial release is strictly cached host metadata with no live SSH, even if useful functionality is limited.

**Q3 · Custody of SSH credentials**
- A (recommended): EdgeSSH remains the only component decrypting SSH credentials, MCP Worker calls narrow internal operations and gets sanitized results.
- B: MCP Worker directly reads EdgeSSH D1 and shares its encryption key / SSH credentials.

**Q4 · Host exposure policy**
- A (recommended): individual Saved Hosts require explicit opt-in to MCP; default deny; no new permission database or RBAC engine.
- B: all Saved Hosts are implicitly accessible to a valid MCP caller.

**Q5 · MCP ingress authentication**
- A (recommended): reuse existing Portal Bearer pattern with a **unique EdgeSSH MCP secret**, not shared with other MCP Workers; direct-client OAuth is out of scope for v1.
- B: reuse the shared token from lower-risk apps.
- C: require direct-client OAuth from v1, with its associated client and grant lifecycle.

## After the first round

Resolve Q1–Q5 and record accepted terminology in `CONTEXT.md`. Only then create an appropriately scoped ADR for the accepted cross-repository boundary if it meets the reversibility/impact threshold. The next grilling round should cover noninteractive SSH lifecycle, host-key enrollment, failure/retry behavior, operator consent for commands, and independent deployment/rollback, **conditioned on the chosen feature scope**. Do not implement, create issues/tickets, or deploy before the user confirms final consensus.
