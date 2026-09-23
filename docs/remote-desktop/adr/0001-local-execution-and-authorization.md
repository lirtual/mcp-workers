# ADR 0001 — Ordinary-account execution, three-layer authorization

Status: **Accepted product/security requirements (Q1–Q4, Q8–Q10, Q14, Q17, Q18, Q20, Q22; 2026-09-23), NOT approved implementation, deployed security, or VPC-vs-DO choice.** Research branch only. Earlier [#170](https://github.com/lirtual/mcp-workers/issues/170) was closed as not planned; [historical ADR](https://github.com/lirtual/mcp-workers/blob/prototype/remote-desktop-vpc-178/.scratch/remote-desktop-vpc/docs/adr/0001-ordinary-account-with-local-authorization.md) is preserved. [CONTEXT](../CONTEXT.md), [decision log](../decision-log.md).

## Context

Goal: self-host an independent Cloudflare remote MCP for the complete *applicable* pinned-version Desktop Commander local tools including Shell, file operations, search and interactive processes. Initial executor is one Linux/WSL2 device. Q13=C previously expressed a desire to use VPC privacy alone; that contradicts historical #172's independently authenticated client/device and Q9/Q10's local action approval. It was blocked, not implemented.

## Decision

1. **Execution identity (Q1=C; Q4=C):** Use the ordinary Linux/WSL2 account and its actual effective permissions. Do not silently elevate/root; do not claim project directory rules sandbox arbitrary Shell. Native Windows host support deferred.
2. **Tool access (Q2=A; Q3=A; Q14=A):** Target complete applicable upstream tool catalog, but reads may be automatic, routine project writes policy-scoped, sensitive Shell/destructive/config/global PID/root/sudo/exfiltration require individually defined gates or are withheld until safe. Do not permit upstream config calls to disable enforcement.
3. **Explicit Q13 reconciliation (Q17=C):** Public `/mcp` remains OAuth-protected; Worker→local adapter uses a **separately revocable device credential**; device requires independent local approval for sensitive actions. Cloudflare VPC is private routing *only*. The old Q13=C no-auth interpretation is **superseded as an authorization choice**; #172 remains consistent. No caller-provided Host, URL, pathname or tool name may redirect a VPC binding to another device.
4. **Approval semantics (Q9=A; Q10=A; Q18=A; Q20=A):** Local UI/CLI, bind authorization to device, exact operation digest, unique nonce and bounded TTL. Approval is one-shot and fails closed when expired/unavailable/offline; each new arbitrary Shell launch separately approved. Subsequent command-affecting stdin requires independent approval or an explicitly bounded time-limited scoped session grant, not unlimited authority from launch approval. Client UI confirmation is not on-device approval.
5. **WSL2 trust (Q8=A; Q22=A):** Windows mounts/interop remain available by choice; direct file-tool operations targeting Windows require separate approval, but an approved arbitrary Shell may indirectly touch reachable Windows mounts/interop. Explain this limitation, offer an optional truly OS-constrained mode, and never claim path checks alone enforce host isolation.
6. **Separation of release gates:** Only fixed-root non-privileged tests before evidence; hosted VPC, actual Linux/WSL2, negative admission, auth refresh/revoke, compatible client, and ChatGPT permissions each separately verified. No production `workflow-mcp-worker` change.

## Consequences

Three distinct controls must work: public client identity, revocable device identity, local individual consent. A private route alone cannot secure a privileged computer tool. Ordinary-account Shell retains broad real permissions even with local approval. Per-input confirmation may make interactive processes less convenient; narrowly scoped grants are permissible only when user explicitly authorizes their scope and expiration.

## Rejected alternatives

- VPC private routing as sole authentication (historical Q13=C): explicitly superseded by Q17=C.
- Single permanent token shared by client, device and local approvals: conflicts with distinct identities, revocation and one-shot consent.
- Unlimited interactive stdin after Shell launch: rejected by Q18=A.
- Require isolated OS account by default: not chosen in Q1=C; remains optional for actual host confinement.
- Unrestricted proxy of all upstream tools or claims of personal ChatGPT Plus Shell/write support: not approved.

## Open verification gates

Implement and test OAuth version/discovery/refresh, device credential rotation/revoke, one-shot approval race/replay, policy bypasses, stdin grant scope, real WSL2 Windows reach, pinned-version tool inventory and client permissions. Exact TTL and byte limits remain measured implementation parameters. Do not select VPC/DO without actual hosted proof. See [feasibility research](../../research/remote-desktop-vpc-feasibility-2026-09-23.md).
