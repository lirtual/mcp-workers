# ADR 0001 — Ordinary-user execution with local authorization

Status: **Accepted product boundary (round 1, 2026-09-23); enforcement details pending round 2.** This ADR is on an unmerged, throwaway exploration branch. It is neither a security certification, transport choice, production deployment authorization nor permission to enable host Shell/write tools.

## Context
[#170](https://github.com/lirtual/mcp-workers/issues/170) targets a personal self-hosted remote MCP with complete applicable local Desktop Commander Shell, read/write, file search, process and session functionality. The user explicitly chose Q1=C, Q2=A, Q3=A, Q4=C, Q5=A, Q6=A and Q7=A in grill-with-docs round 1. Existing #173/#178 CI only tests fixed-root reads in disposable Docker. [Desktop Commander security policy](https://github.com/wonderwhy-er/DesktopCommanderMCP/security) explains that allowed directories and command blocklists do not constrain arbitrary Shell; native user permissions are the real host access boundary.

## Decision
- **Execution identity:** Initial device is Linux or WSL2 Linux, using the user's ordinary login account and its actual permissions. Do not require a dedicated restricted identity by default. Never silently elevate to root/sudo; native Windows-host executor is not in initial scope.
- **Catalog versus authorization:** Expose the complete applicable upstream core catalog as the goal, but security config changes, system-wide process manipulation and privilege actions require additional gating. A capability being present is not unconditional authority to use it.
- **Local policy:** Reads can be automatic; routine writes in user-selected project scopes are policy-gated; sensitive Shell, destructive and privileged operations require explicit local approval or a bounded time-limited grant. Implement device-side authorization independently of remote-client prompts and independently of VPC transport.
- **Long-running sessions:** Support status, paginated output, stopping and reconnect reconciliation. Minimal audit, operation receipts, health and revoke are part of the domain; the approved client can differ from ChatGPT under its actual plan permissions.
- **Scope:** Preserve independent workflow-mcp-worker production, #178 as the sole active transport frontier and #173/#177 as read-only fallback; no merge/deploy/high-privilege test follows from this ADR.

## Consequences and accepted risk
1. An authorized arbitrary Shell inherits the ordinary account's ability to access its home directory, reachable credentials, network and (for WSL2) potentially Windows mounts/interop. Project directory and command allow/block lists cannot guarantee containment. Treat this as a **real risk tradeoff accepted by choosing Q1=C**, not an isolation guarantee.
2. Local approval reduces unauthorized dispatch and accidental actions but does not make the ordinary account an OS sandbox or prevent an already-authorized command from performing unanticipated side effects. If strong confinement is mandatory, the decision must be revisited in favor of an OS-restricted identity/container/VM.
3. Detailed implementation of approval, fail-closed behavior, grant scope, credential handling, WSL2 host reach, revocation of active sessions, timeout and hard termination is **UNRESOLVED**. No general Shell or write capability may be enabled until separately specified and verified.
4. Cloudflare VPC/Tunnel provides routing, not identity or tool authorization. ChatGPT Plus permission cannot be inferred from a working MCP protocol or another compatible client's result.

## Alternatives considered
- Dedicated low-privilege account or container/VM: stronger isolation but rejected as the **mandatory default** by Q1=C, not prohibited as an optional mode.
- Unconditional upstream tool pass-through: rejected by Q2=A and Q3=A.
- Read-only service as final product: rejected by the stated complete-capability goal.
- Native Windows-first delivery: deferred by Q4=C.

## Follow-up gates
Resolve [round 2](../../GRILL-WITH-DOCS.md) before writing an approved Spec. Use isolated read-only transport tests until local authorization, negative tests, a compatible client and real connectivity are evidenced.
