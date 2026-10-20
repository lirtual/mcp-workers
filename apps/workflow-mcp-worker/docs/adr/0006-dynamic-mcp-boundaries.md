---
status: accepted
date: 2026-10-20
---

# Dynamic MCP invocation has transport, credential, network and operation boundaries

Workflow MCP continues to discover and invoke arbitrary **non-preregistered** MCP Servers (**Q7=B**). Its initial supported transport is **Streamable HTTP** (**Q14=A**); legacy SSE and stdio are not first-release requirements. An owner may authorize a target when connecting and securely retain *target-specific* credentials for recurring executions, without automatically forwarding the Portal token (**Q15=A**). Dynamic endpoints require SSRF/network protections: block cloud metadata, loopback, and unintended private-network targets; address DNS-rebinding and redirect bypasses (**Q16=A**). Enabling a Workflow includes confirmation of its external operation authority; an already-approved scheduled Run does not require fresh approval on every occurrence, while newly introduced high-risk operations require re-approval (**Q17=A**).

## Alternatives considered

- Require static target registration (rejected already by Q7=B).
- Build compatibility for every MCP transport immediately.
- Require credentials on every execution, preventing convenient unattended schedules.
- Allow unrestricted target networking.
- Treat Portal authentication as blanket authorization to execute all discovered tools unattended.

## Consequences and unresolved contracts

**No registration/allowlist requirement is being restored.** Runtime discovery remains dynamic for any *supported, safely reachable* MCP endpoint; authentication may be configured on demand. These decisions do **not** approve storing credentials in plaintext D1, credential-sharing between targets, automatic forwarding of broad user credentials, a fixed secret-vault product, or unrestricted side effects.

Next-round design must resolve exactly **what constitutes an approved target/operation** if an MCP Server can change its tool/schema after publication; whether a workflow with dynamically computed targets/tools may run unattended; and what happens when credentials expire, endpoints redirect, or tool metadata changes. Exact Cloudflare Worker transport feasibility, secure secret persistence mechanism, DNS resolution/redirection enforcement, network restrictions, approval invalidation, and token rotation are **open implementation or design questions**, not silently assumed to be solved.

Design decision only. No implementation, merge, deployment, credentials, or Tickets are authorized.
