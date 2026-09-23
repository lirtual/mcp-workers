# #170 Remote Desktop MCP — grill-with-docs decision log

Date: 2026-09-23. **Round 1 accepted; round 2 questions OPEN.** Not a production Spec, transport decision, high-privilege test authorization, or permission to merge/deploy. [#170 root](https://github.com/lirtual/mcp-workers/issues/170) · [#178 transport frontier](https://github.com/lirtual/mcp-workers/issues/178) · [Draft PR #179](https://github.com/lirtual/mcp-workers/pull/179). [#173](https://github.com/lirtual/mcp-workers/issues/173) and [Draft PR #177](https://github.com/lirtual/mcp-workers/pull/177) remain isolated DO/WS fallback evidence.

## Round 1 — accepted user decisions (2026-09-23)

| ID | Choice | Decided contract | Residual qualification |
| --- | --- | --- | --- |
| Q1 | C | Execute under the user's **ordinary Linux/WSL2 login account** with that account's actual rights, not an obligatory dedicated account. | A configured project directory does not contain arbitrary Shell. Account rights and network access remain real. Root/sudo escalation is **not** implicitly granted. |
| Q2 | A | Aim for version-pinned upstream **complete applicable core tool coverage**. Apply additional authorization gates to sensitive configuration, global PID/process manipulation and privileged actions. | Exact catalog/schema and individual risk classes need an inventory; no unconditional bypass via upstream config changes. |
| Q3 | A | Allow normal reads, policy-scoped routine project writes; require local approval or time-limited scope for sensitive Shell, destructive or privileged actions. | The local enforcement/approval channel and what happens if unavailable are **unresolved**; ChatGPT dialog alone is not proof of local approval. A Shell granted to ordinary account may reach resources outside a project scope. |
| Q4 | C | Initial execution target **Linux and Linux within WSL2**. Native Windows executor is excluded from initial acceptance. | WSL2 interop and `/mnt/c` can still reach Windows-host assets; whether to disable/limit them is a second-round decision. |
| Q5 | A | Support local long-running sessions with bounded logs, status, explicit termination and disconnected/reconnected queries. | State ownership, process identity, hard-kill and retry semantics not settled. |
| Q6 | A | Deliver full-capability MCP for actually compatible clients; validate ChatGPT separately under actual plan/tool permissions. | No assumption that personal Plus permits unrestricted Shell/write. |
| Q7 | A | Include minimal health, audit, revoke, operation receipts/results and bounded output; do not build a scheduler or a second workflow engine. | Audit retention and operation identity semantics not settled. |

The initial `sandbox_ping` / fixed-root `sandbox_list_directory` CI remains a **transport-only proof**. This round neither changes [#178](https://github.com/lirtual/mcp-workers/issues/178)'s transport status nor authorizes host execution. See [CONTEXT.md](./CONTEXT.md) and [local execution policy ADR](./docs/adr/0001-ordinary-account-with-local-authorization.md).

## Primary-source/security cross-check

- [Upstream tool inventory](https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/main/README.md): terminal, interactive processes, file read/write/search and config. The existing pinned Docker `@wonderwhy-er/desktop-commander@0.2.51` is **not** an audited full-tool matrix. Avoid promising unavailable host GUI/private cloud features.
- [Upstream Security Policy](https://github.com/wonderwhy-er/DesktopCommanderMCP/security): allowed directories, blocked commands and symlink guardrails **are not a sandbox** for arbitrary Shell. The user's Q1=C is an explicit broader risk choice; if strict exclusion of other host files/secrets is required, revisit Q1 or impose OS isolation. Never call the Q3 policy a hard confinement guarantee.
- [OpenAI developer mode](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt): Full MCP modification support is restricted by current client plan/permissions. Client integration acceptance remains separate from server capability.
- [Workers VPC](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/) / [Tunnel](https://developers.cloudflare.com/workers-vpc/configuration/tunnel/): network privacy is not device-tool authorization; actual VPC and WSL networking remain unverified.

## Conflict audit: original #170/#173/#178 vs round 1

1. **Old prototype rule vs final product:** #173/#178 prohibit unrestricted host privileges and test only read-only Docker fixture. KEEP that rule for existing prototypes. It is **not the settled final execution identity** (Q1=C), and does not imply read-only final tools.
2. **Old OS scope:** #170/#178 mention Windows/Linux in initial goals. Q4=C narrows **initial** executor acceptance to Linux/WSL2. Update candidate validation plans accordingly, not past evidence. Windows-native is a possible later enhancement.
3. **Q1=C ↔ Q3=A security tension:** unrestricted account + arbitrary Shell defeats directory restrictions. Local approval, TTL and an OS identity may reduce accidents but cannot guarantee project-only effects. Second round must determine the user-accepted security guarantee and whether Shell needs local per-call approval.
4. **Q5=A ↔ stateless VPC assumption:** interactive session and receipt state must live on the device; DO/D1 is NOT automatically required just for session status. Offline replay and cancellation still need protocol semantics and tests.
5. **Q6=A ↔ ChatGPT-first phrasing:** full-capability remote MCP may be accepted using compatible clients while personal ChatGPT remains read-only/unavailable for specific operations. No fabricated Plus acceptance.
6. **Q7=A ↔ keep it minimal:** minimum local audit/receipts/health is in scope; no need for Queue/D1/Workflow scheduler without separate evidence.
7. **Q2=A ↔ 'full features':** implement complete applicable upstream catalog behind policy, not an unrestricted raw proxy for security config or arbitrary PID. Exact pinned-version tool compatibility needs a separate evidence table.
8. **Old `8192` limit ↔ writing/large outputs:** 8 KiB is a prototype transport cap, not the final file/terminal size; streaming, chunking, pagination and artifact controls require decisions.

## Round 2 — frontier questions, all undecided (proposed defaults do NOT mean approval)

**Q8 · Trust boundary and WSL reach.** A = accept ordinary WSL/Linux account scope as broad host trust, keep `/mnt/c` / Windows interop available but require explicit per-operation approval for Windows-side paths and privileged bridging (default candidate); B = disable Windows interop and unmount/restrict Windows drives at OS boundary, accepting narrower full features; C = explicitly allow all assets reachable by ordinary account, with the same general policy as Linux paths. Clarify that A/C cannot guarantee against Shell indirect reach once authorized.

**Q9 · Local approval mechanism.** A = approval issued by separate local device UI/CLI, bound to device, exact action digest, short expiry; fail closed if unreachable (default); B = solely remote ChatGPT/client confirmation; C = no approval, only general scope/token. Note that an action running when the user is absent cannot be approved interactively; timed pre-grants require exact boundaries.

**Q10 · Shell authority.** A = explicit approval for **every new arbitrary Shell launch**; separately policy-gate interactive input, scripts and dangerous escalation (default); B = time-limited broad Shell grant for a selected project/session; C = automatically allow Shell inside a named working directory. C is only an advisory scope unless OS isolation is added.

**Q11 · Persistent session/revoke.** A = local registry with stable session IDs, distinguish queued/running/completed/unknown; after disconnect, query status and never auto-replay side effects; revoke blocks new calls, explicit policy decides existing process handling (default); B = always terminate running sessions on network disconnect/revoke; C = transparently retry any ambiguous calls. Do not treat C as safe for writes or commands.

**Q12 · Large content and output.** A = bounded per-request control plane, paginated output and file chunk transfer with explicit quotas; no raw secrets in logs (default); B = direct large request/response across MCP/VPC; C = introduce R2 artifact storage immediately. Actual tool and host constraints must be measured before limits are frozen.

**Q13 · Authorization/session/token lifetime.** A = distinct OAuth client and device credential, device-local approval receipt and time-limited grant; rotate/revoke credentials without reusing cloud OAuth as local authority (default); B = single permanent shared token for Worker + adapter + approvals; C = rely on VPC private routing alone.

**Q14 · Sensitive tools and permissions.** A = configuration affecting security, arbitrary PID kill, sudo/root/network exfiltration treated as separately gated or unsupported until reviewed (default); B = full raw pass-through, unconditionally; C = remove all sensitive categories from final tool catalog. Clarify whether 'complete' means advertised-with-gate or unconditional capability.

**Q15 · Device management minimalism.** A = Linux/WSL2 single-device first; local health/audit receipts and startup/reconnect; use no additional DO/D1/Queue unless measured need (default); B = design multi-device dynamic registry and cloud-persisted audit from v1; C = no local audit or identity tracking.

**Q16 · Acceptance contract.** A = separate gates for real VPC (if selected), actual Linux/WSL2 restricted tests, policy-negative tests and compatible client; record ChatGPT eligibility independently (default); B = call project done on simulated CI; C = full feature acceptance requires personal ChatGPT Plus Shell/write even if unsupported by client.

**Do not create implementation tickets or make a transport verdict until this round and actual #178 evidence are complete.**
