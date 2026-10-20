---
status: accepted
date: 2026-10-20
---

# Dynamic MCP invocation has transport, credential, network and operation boundaries

Workflow MCP continues to discover and invoke arbitrary **non-preregistered** MCP Servers (**Q7=B**). Its initial supported transport is **Streamable HTTP** (**Q14=A**); legacy SSE and stdio are not first-release requirements. An owner may authorize a target when connecting and securely retain *target-specific* credentials for recurring executions, without automatically forwarding the Portal token (**Q15=A**). Dynamic endpoints require SSRF/network protections: block cloud metadata, loopback, and unintended private-network targets; address DNS-rebinding and redirect bypasses (**Q16=A**). Publishing a Workflow includes confirmation of its external operation authority; an already-approved scheduled Run does not require fresh approval on every occurrence, while newly introduced high-risk operations require re-approval (**Q17=A**, refined by **Q19=A** and **Q20=A**, ADR-0008).

## Alternatives considered

- Require static target registration (rejected already by Q7=B).
- Build compatibility for every MCP transport immediately.
- Require credentials on every execution, preventing convenient unattended schedules.
- Allow unrestricted target networking.
- Treat Portal authentication as blanket authorization to execute all discovered tools unattended.

## Consequences and unresolved contracts

**No registration/allowlist requirement is being restored.** Runtime discovery remains dynamic for any *supported, safely reachable* MCP endpoint; authentication may be configured on demand. Round 4 **Q21=A** (ADR-0009) authorizes encrypted D1 credential records protected by an independent Worker Secret, not plaintext D1, credential-sharing between targets, automatic forwarding of broad user credentials, a new external vault product, or unrestricted side effects. **Q22=A** requires validated current and recent Streamable HTTP protocol compatibility; it does not mandate support for every old transport or version.

Round 5 **Q28=A** (ADR-0008) now binds approval to a specific target identity, tool and operation scope rather than to a globally reusable tool name; **Q30=A** (ADR-0009) allows same-scope credential rotation without workflow republication and blocks new use after revocation. The exact representation of target identity, whether unknown runtime-computed targets/tools may run unattended, and behavior on expiry, redirects or tool metadata drift remain open. Exact Cloudflare Worker transport feasibility, version negotiation, encryption envelope/key rotation, DNS resolution/redirection enforcement, network restrictions, approval invalidation, and credential rotation are **open implementation or design questions**, not silently assumed to be solved.

Design decision only. No implementation, merge, deployment, credentials, or Tickets are authorized.
