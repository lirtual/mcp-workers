# Remote Desktop MCP #170 — decision log

Status: exploration in [#170](https://github.com/lirtual/mcp-workers/issues/170); **do not merge, deploy, enable Shell/write, or treat as an approved Spec**. [Detailed grilling and open questions](./GRILL-WITH-DOCS.md), [domain context](./CONTEXT.md), [accepted execution ADR 0001](./docs/adr/0001-ordinary-account-with-local-authorization.md), [local session ADR 0002](./docs/adr/0002-local-session-reconciliation-and-bounded-transfer.md). #178 is the single open transport-decision frontier.

| Date | IDs | User choice | Status and implementation boundary |
| --- | --- | --- | --- |
| 2026-09-23 | Q1=C; Q2=A; Q3=A; Q4=C | Ordinary Linux/WSL2 account, full applicable upstream catalog with sensitive gates, policy writes/local approval, Linux/WSL2 first | Accepted product direction. Shell inherits full account privileges; directories do not sandbox; never silently elevate. |
| 2026-09-23 | Q5=A; Q6=A; Q7=A | Persistent local sessions, full capability on compatible clients and separate ChatGPT acceptance, minimal health/audit/revoke/receipts | Accepted product direction. Old read-only CI is transport-only. |
| 2026-09-23 | Q8=A; Q9=A; Q10=A | Windows mounts/interop remain available with direct Windows operation approval, local action-bound expiring fail-closed approval, approval per new Shell launch | Accepted, with explicit warning that an approved Shell can indirectly reach Windows paths; stdin policy pending. |
| 2026-09-23 | Q11=A; Q12=A | Local session IDs, unknown states/no blind replay, bounded control, paginated output, chunked file transfer | Accepted; process treatment on revoke, numeric budgets and integrity rules pending. |
| 2026-09-23 | Q13=C | Rely on VPC private routing alone | **User-selected, not implementable as a final auth decision until reconciled** with #172's OAuth-protected `/mcp`, distinct revocable device credential, and Q9/Q10 local approval. Do not silently supersede #172. Round-3 Q17 seeks exact intended layer. |
| 2026-09-23 | Q14=A; Q15=A; Q16=A | Independently gate sensitive tools, single device/local audit, separate real hosted VPC / Linux/WSL2 / compatible-client gates | Accepted, but not technically validated or permission to ship. |
| 2026-09-23 | Q17–Q23 | Distinct client/adapter auth, interactive stdin grants, running process revoke, approval expiry, audit retention, WSL2 path trust, hosted private ingress | **Questions OPEN**, see GRILL-WITH-DOCS.md. |

## Prior decision and evidence preservation

- [#171](https://github.com/lirtual/mcp-workers/issues/171) independent local bridge rather than private hosted backend: remains historical settled research.
- [#172](https://github.com/lirtual/mcp-workers/issues/172) distinct OAuth-protected client and revocable device credentials: remains the previous recorded decision until explicitly reconciled; Q13=C does NOT silently invalidate it.
- [#173](https://github.com/lirtual/mcp-workers/issues/173) / [Draft PR #177](https://github.com/lirtual/mcp-workers/pull/177) local-only DO/WS, fixed-root read-only fallback.
- [#178](https://github.com/lirtual/mcp-workers/issues/178) / [Draft PR #179](https://github.com/lirtual/mcp-workers/pull/179) VPC private route hypothesis with mocked binding in CI. Real VPC Service/Tunnel, Linux/WSL2 device, OAuth/ChatGPT and Shell/write remain unverified.
- Do not modify production workflow-mcp-worker or Cloudflare resources. No new full-feature spec or implementation tickets until Q13 conflict and real transport/client acceptance are settled.
