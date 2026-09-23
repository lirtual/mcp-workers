# ADR 0002 — Local session reconciliation and bounded transfer

Status: **Accepted product/lifecycle direction (round 2, 2026-09-23); numeric budgets and stop policy pending.** This exploratory ADR on the unmerged #179 branch is not a production implementation or a VPC/DO transport verdict.

## Context
The user selected Q5=A (long-running sessions), Q7=A (minimal audit/health/revocation), Q11=A (stable local session registry/no blind retries), Q12=A (small control messages/paginated output/chunked transfers), Q15=A (one Linux/WSL2 device, local state) and Q16=A (separate end-to-end acceptance gates). A stateless Workers VPC candidate is being compared with the prior DO/WebSocket relay in [#178](https://github.com/lirtual/mcp-workers/issues/178). An interrupted request may have started, completed or failed without returning a result; a timeout is not evidence that a command was cancelled.

## Decision
- The device owns the authoritative state for **local** interactive process sessions and operation receipts. Assign stable operation/session IDs, track queued/running/completed/failed/unknown, and query status after reconnect. Do not automatically retry commands or writes whose outcome is uncertain.
- Revocation denies **new dispatch** and new interactive input; treatment of already-running managed processes is explicitly unresolved pending round-3 Q19. Killing arbitrary host PIDs is not a valid default.
- Send small bounded control calls; use paginated process output and quota-controlled chunked file transfer. Exact size, integrity, expiry and storage choices require empirical implementation evidence.
- Record bounded local metadata/audit, device health, and results. Do not add cloud DO/D1/R2 or a scheduler just because there are sessions, receipts or files; add a component only if transport, reliability, size or access requirements demonstrate a need.
- Keep Shell/write disabled in read-only #173/#178 prototypes until separately approved. Final acceptance requires actual Linux/WSL2 operation, real hosted private connectivity (if VPC selected), negative policy cases and compatible MCP client; ChatGPT entitlement is independently recorded.

## Consequences
- Short Worker requests may return an operation receipt that is later queried instead of holding open the request. This is a candidate protocol shape, not yet a settled tool schema.
- A network failure can leave an **unknown** operation outcome; the user must query the device before deliberately repeating side effects. Local state may be unavailable if the device or its disk fails.
- A local process can outlive network connectivity; no blanket promise of cancellation, replay or seamless exactly-once execution is made.
- Streaming, security-sensitive output/secret redaction, retention, storage durability, stable ID collision and chunk integrity tests remain mandatory before privileged execution.

## Alternatives considered
- Re-send on reconnect: rejected for side-effecting work because it may run twice.
- Always kill on disconnect: not chosen (Q11=A vs B), pending separate policy for explicit revoke.
- Cloud state as mandatory session authority: not justified for one device; may be revisited with evidence.
- Transfer whole files in one large request or mandate R2: not chosen by Q12=A.

## Open gates
Round-3 [Q18–Q21](../../GRILL-WITH-DOCS.md), the contradictory authorization choice Q13=C, real #178 hosted transport, operation tool schemas and actual platform/client permissions.
