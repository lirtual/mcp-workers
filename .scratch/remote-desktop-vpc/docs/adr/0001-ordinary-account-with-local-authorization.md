# ADR 0001 — Ordinary-user execution with local authorization

Status: **Accepted execution/product boundary (rounds 1–2, 2026-09-23); Q13 transport-only trust choice remains CONFLICTED and enforcement details require round 3.** This ADR is on an unmerged, throwaway exploration branch. It is neither a security certification, transport choice, production deployment authorization nor permission to enable host Shell/write tools.

## Context
[#170](https://github.com/lirtual/mcp-workers/issues/170) targets a personal self-hosted remote MCP with complete applicable local Desktop Commander Shell, read/write, file search, process and session functionality. The user explicitly chose Q1=C, Q2=A, Q3=A, Q4=C, Q5=A, Q6=A and Q7=A in grill-with-docs round 1. Existing #173/#178 CI only tests fixed-root reads in disposable Docker. [Desktop Commander security policy](https://github.com/wonderwhy-er/DesktopCommanderMCP/security) explains that allowed directories and command blocklists do not constrain arbitrary Shell; native user permissions are the real host access boundary.

## Decision
- **Execution identity:** Initial device is Linux or WSL2 Linux, using the user's ordinary login account and its actual permissions. Do not require a dedicated restricted identity by default. Never silently elevate to root/sudo; native Windows-host executor is not in initial scope.
- **Catalog versus authorization:** Expose the complete applicable upstream core catalog as the goal, but security config changes, system-wide process manipulation and privilege actions require additional gating. A capability being present is not unconditional authority to use it.
- **Local policy:** Reads can be automatic; routine writes in user-selected project scopes are policy-gated; sensitive Shell, destructive and privileged operations require explicit local approval or a bounded time-limited grant. Per Q9=A approval is local UI/CLI, exact-operation/device-bound and short-lived, and fails closed when unavailable. Per Q10=A each new arbitrary Shell launch requires separate approval; later interactive input policy remains open. Direct Windows-targeting WSL2 operations receive separate approval per Q8=A, but an approved Shell can still reach these resources indirectly.
- **Long-running sessions:** Support stable local operation/session IDs and queued/running/completed/unknown states, paginated output, explicit stopping and reconnect reconciliation; never automatically replay ambiguous side-effecting work (Q11=A). Revocation denies fresh dispatch; active-process treatment remains open. Chunked file transfer, bounded controls and quotas (Q12=A) and minimal one-device health/audit/receipts (Q15=A) are agreed. Independently validate hosted transport, Linux/WSL2, negative policy tests and compatible client; ChatGPT is separate (Q16=A).
- **Scope:** Preserve independent workflow-mcp-worker production, #178 as the sole active transport frontier and #173/#177 as read-only fallback; no merge/deploy/high-privilege test follows from this ADR.

## Consequences and accepted risk
1. An authorized arbitrary Shell inherits the ordinary account's ability to access its home directory, reachable credentials, network and (for WSL2) potentially Windows mounts/interop. Project directory and command allow/block lists cannot guarantee containment. Treat this as a **real risk tradeoff accepted by choosing Q1=C**, not an isolation guarantee.
2. Local approval reduces unauthorized dispatch and accidental actions but does not make the ordinary account an OS sandbox or prevent an already-authorized command from performing unanticipated side effects. If strong confinement is mandatory, the decision must be revisited in favor of an OS-restricted identity/container/VM.
3. Local approval, fail-closed behavior and new Shell approval are product decisions; exact mechanism, interactive-stdin and grant scopes, WSL2 indirect reach, revocation of active sessions, byte/retention quotas and hard termination remain **UNRESOLVED**. No general Shell or write capability may be enabled until separately specified and verified.
5. **Q13=C is recorded as a contradictory user choice, not an authorized exception:** VPC routing alone cannot authenticate public MCP clients or replace local approval. Closed #172's client OAuth + distinct revocable device credential is still the valid prior decision. Round-3 Q17 must explicitly reconcile its scope before altering authentication. Do not silently ignore #172 or silently substitute Q13=A.
4. Cloudflare VPC/Tunnel provides routing, not identity or tool authorization. ChatGPT Plus permission cannot be inferred from a working MCP protocol or another compatible client's result.

## Alternatives considered
- Dedicated low-privilege account or container/VM: stronger isolation but rejected as the **mandatory default** by Q1=C, not prohibited as an optional mode.
- Unconditional upstream tool pass-through: rejected by Q2=A and Q3=A.
- Read-only service as final product: rejected by the stated complete-capability goal.
- Native Windows-first delivery: deferred by Q4=C.

## Follow-up gates
Resolve [Q13 conflict and round 3](../../GRILL-WITH-DOCS.md), plus actual #178/compatible-client evidence, before writing an approved Spec. Use isolated read-only transport tests until local authorization, negative tests, a compatible client and real connectivity are evidenced.
