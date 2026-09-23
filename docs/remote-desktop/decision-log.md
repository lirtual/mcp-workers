# Remote Desktop MCP — decision-log

> 2026-09-23; documentation-only research branch, NOT approved Spec/transport, deployment or permission to enable Shell/write. [#170](https://github.com/lirtual/mcp-workers/issues/170), [#178](https://github.com/lirtual/mcp-workers/issues/178), [PR #177](https://github.com/lirtual/mcp-workers/pull/177) and [PR #179](https://github.com/lirtual/mcp-workers/pull/179) were closed as not planned/unmerged at the owner's earlier request. Their code and CI remain historical references. This is a **new research record**, not a reopening of those tickets. See [CONTEXT](./CONTEXT.md), [ADR 0001](./adr/0001-local-execution-and-authorization.md), [ADR 0002](./adr/0002-local-session-and-bounded-transfer.md), and [feasibility research](../research/remote-desktop-vpc-feasibility-2026-09-23.md).

| Date | Decisions | Status, scope, remaining qualification |
| --- | --- | --- |
| 2026-09-23 | Q1=C Q2=A Q3=A Q4=C | Accepted design requirements: ordinary Linux/WSL2 account, guarded complete applicable upstream catalog, scoped routine writes and local sensitive-action approval, Linux/WSL2 first. OS privileges remain real; no root/sudo by default. |
| 2026-09-23 | Q5=A Q6=A Q7=A | Persistent local sessions, compatible client independently of actual ChatGPT permissions, minimal health/audit/revoke/receipts. |
| 2026-09-23 | Q8=A Q9=A Q10=A | WSL Windows mounts/interop remain; direct Windows actions additionally approved; independent action-bound local UI/CLI confirmation, fresh approval per Shell launch. Indirect Windows access via approved Shell is still possible. |
| 2026-09-23 | Q11=A Q12=A Q14=A Q15=A Q16=A | Stable device operation/session IDs and unknown/no blind replay, bounded control/output/file chunks, separate sensitive-tool gates, one-device local state, independent real hosted/device/client acceptance. |
| 2026-09-23 | Historical Q13=C | Previously proposed relying on private VPC routing alone, explicitly conflicted with #172/Q9/Q10. **Superseded as an authorization choice by Q17=C**, not silently ignored. |
| 2026-09-23 | **Q17=C** | **Accepted:** retain OAuth-protected public `/mcp`, distinct revocable Worker→device credential, and independent local approval; VPC is private network routing only. Restores consistency with historic #172. |
| 2026-09-23 | **Q18=A** | **Accepted:** each new Shell launch approved; command-affecting stdin separately approved or explicitly covered by bounded scoped session grant. No indefinite stdin inheritance. |
| 2026-09-23 | **Q19=A** | **Accepted:** revoke blocks new dispatch and stdin immediately. Existing managed processes continue; separately authorized local stop required. Do not claim revocation automatically kills arbitrary host processes. |
| 2026-09-23 | **Q20=A** | **Accepted:** device-local sensitive approval has bounded pending period, expiration, one-shot nonce, operation hash and device binding; offline/unavailable fails closed. Exact durations pending measurements/spec. |
| 2026-09-23 | **Q21=A** | **Accepted:** bounded local metadata-only audit/receipt; proposed configurable default 7 days, no stdout, file payload or secrets in cloud by default. Exact retention settings still require implementation decision. |
| 2026-09-23 | **Q22=A** | **Accepted:** state actual WSL2 Windows mount/interop risk openly; direct Windows file tools need approval but approved Shell may indirectly access those resources. Optional OS-constrained mode for strong isolation. |
| 2026-09-23 | **Q23=A** | **Accepted:** real hosted tests via independent nonpublic/authenticated ingress, never unauthenticated public probe. No actual Tunnel/VPC/compatible-client proof yet. |

## Conflict audit — disposition

- **Resolved at requirement level:** Q13=C vs #172 / Q9 / Q10 is reconciled by explicit Q17=C, so transport privacy does not supplant identities or local consent. No authorization removal may be inferred from VPC.
- **Bounded but inherent risk:** ordinary account (Q1) and full Shell (Q2) vs project/Windows scope (Q3/Q8/Q22). Local approval cannot guarantee filesystem containment once an arbitrary Shell is authorized. Optional OS-restricted mode is not the default.
- **Resolved lifecycle rule:** Q10 vs Q18 requires additional stdin policy; Q11 vs Q19 distinguishes revoking new input from stopping existing processes; Q20 prohibits delayed replay of expired approvals.
- **Still unverified:** no real VPC service or live private Tunnel on the account at last read; previous PR #179 used mocked VPC binding (4/4 CI), PR #177 used local DO/WS. Neither established hosted VPC, endpoint OAuth/refresh, local Shell/write authorization, native Linux/WSL2, or ChatGPT permissions.
- **Still to specify/measure:** exact upstream tool matrix, credentials/nonce and policy implementation, numeric size/time/retention limits, process termination semantics and independent real hosted VPC and compatible-client acceptance.

## Release freeze and evidence sequence

Read-only isolated tests first → independent, actually connected private Tunnel + VPC Service binding → fixed-root real Desktop Commander stdio round trip + negative/expiry/recovery tests → OAuth/Portal + compatible-client proof → full local authorization tests only under separately approved safe conditions → final VPC/DO measurement/ADR and optional to-spec. No production changes, merging or high-privilege tools at this research stage.
