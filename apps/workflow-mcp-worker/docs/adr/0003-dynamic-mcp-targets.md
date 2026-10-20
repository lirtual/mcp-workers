---
status: accepted
date: 2026-10-20
---

# Discover and invoke MCP Servers without preregistration

Workflow MCP must support dynamic discovery and invocation of arbitrary MCP Servers without a prerequisite static Connection registry or server allowlist. This is the owner's explicit Round 2 decision **Q7=B**, in preference to **Q7=A**, where only pre-registered connections could be addressed. It enables workflows to compose newly encountered MCP capabilities without editing source code or deploying new connection metadata.

## Considered alternatives

- A pre-registered, centrally configured MCP Connection catalog that limits callable servers (**rejected as a requirement**).
- Dynamic discovery and calls to arbitrary MCP Servers without preregistration (**accepted**).

## Consequences

The historical v0.1 specification's static Connection requirement and prohibition on dynamic MCP endpoints are superseded. Do **not** silently reinterpret this decision as a mandatory allowlist or preregistration step. Round 3 **Q14–Q17=A** (ADR-0006) now selects initial Streamable HTTP transport, on-demand target-specific credential grants, blocking unsafe SSRF targets and redirect/rebinding bypasses, and activation-time confirmation of external operation authority with renewed confirmation for new high-risk operations. Detailed credential storage, exact network enforcement, dynamic target/tool identity, approval invalidation and failure/retry semantics remain **open**. Arbitrary target discovery continues to require **no static preregistration**, but it never implies unrestricted egress, Portal-token forwarding, or blanket unattended side effects.
