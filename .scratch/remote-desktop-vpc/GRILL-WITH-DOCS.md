# #170 Remote Desktop MCP — grill-with-docs decision log

Date: 2026-09-23. **Rounds 1 and 2 recorded; Q13=C CONFLICTED and not implementation-ready; round 3 questions OPEN.** Not a production Spec, transport decision, high-privilege test authorization, or permission to merge/deploy. [#170 root](https://github.com/lirtual/mcp-workers/issues/170) · [#178 transport frontier](https://github.com/lirtual/mcp-workers/issues/178) · [Draft PR #179](https://github.com/lirtual/mcp-workers/pull/179). [#173](https://github.com/lirtual/mcp-workers/issues/173) and [Draft PR #177](https://github.com/lirtual/mcp-workers/pull/177) remain isolated DO/WS fallback evidence.

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

## Round 2 — original offered questions (historical; user choices and qualifications recorded below)

**Q8 · Trust boundary and WSL reach.** A = accept ordinary WSL/Linux account scope as broad host trust, keep `/mnt/c` / Windows interop available but require explicit per-operation approval for Windows-side paths and privileged bridging (default candidate); B = disable Windows interop and unmount/restrict Windows drives at OS boundary, accepting narrower full features; C = explicitly allow all assets reachable by ordinary account, with the same general policy as Linux paths. Clarify that A/C cannot guarantee against Shell indirect reach once authorized.

**Q9 · Local approval mechanism.** A = approval issued by separate local device UI/CLI, bound to device, exact action digest, short expiry; fail closed if unreachable (default); B = solely remote ChatGPT/client confirmation; C = no approval, only general scope/token. Note that an action running when the user is absent cannot be approved interactively; timed pre-grants require exact boundaries.

**Q10 · Shell authority.** A = explicit approval for **every new arbitrary Shell launch**; separately policy-gate interactive input, scripts and dangerous escalation (default); B = time-limited broad Shell grant for a selected project/session; C = automatically allow Shell inside a named working directory. C is only an advisory scope unless OS isolation is added.

**Q11 · Persistent session/revoke.** A = local registry with stable session IDs, distinguish queued/running/completed/unknown; after disconnect, query status and never auto-replay side effects; revoke blocks new calls, explicit policy decides existing process handling (default); B = always terminate running sessions on network disconnect/revoke; C = transparently retry any ambiguous calls. Do not treat C as safe for writes or commands.

**Q12 · Large content and output.** A = bounded per-request control plane, paginated output and file chunk transfer with explicit quotas; no raw secrets in logs (default); B = direct large request/response across MCP/VPC; C = introduce R2 artifact storage immediately. Actual tool and host constraints must be measured before limits are frozen.

**Q13 · Authorization/session/token lifetime.** A = distinct OAuth client and device credential, device-local approval receipt and time-limited grant; rotate/revoke credentials without reusing cloud OAuth as local authority (default); B = single permanent shared token for Worker + adapter + approvals; C = rely on VPC private routing alone.

**Q14 · Sensitive tools and permissions.** A = configuration affecting security, arbitrary PID kill, sudo/root/network exfiltration treated as separately gated or unsupported until reviewed (default); B = full raw pass-through, unconditionally; C = remove all sensitive categories from final tool catalog. Clarify whether 'complete' means advertised-with-gate or unconditional capability.

**Q15 · Device management minimalism.** A = Linux/WSL2 single-device first; local health/audit receipts and startup/reconnect; use no additional DO/D1/Queue unless measured need (default); B = design multi-device dynamic registry and cloud-persisted audit from v1; C = no local audit or identity tracking.

**Q16 · Acceptance contract.** A = separate gates for real VPC (if selected), actual Linux/WSL2 restricted tests, policy-negative tests and compatible client; record ChatGPT eligibility independently (default); B = call project done on simulated CI; C = full feature acceptance requires personal ChatGPT Plus Shell/write even if unsupported by client.

**No implementation tickets, privileged deployment, or transport verdict until Q13 and real #178/client evidence are resolved.**

## Round 2 — explicit user responses and decision status (2026-09-23)

| ID | User choice | Recorded disposition and open qualification |
| --- | --- | --- |
| Q8 | A | **Accepted:** leave WSL2 Windows mounts/interop available; require a separate approval for direct Windows-targeting actions. An already approved arbitrary Shell can reach those assets indirectly; no guaranteed Windows path isolation. |
| Q9 | A | **Accepted:** independent on-device UI/CLI approval, bound to device + exact request digest + short expiration, fail closed if approval unavailable. Do not treat client confirmation as sufficient. |
| Q10 | A | **Accepted:** approve each new arbitrary Shell launch. Interactive follow-up input, remote scripts, privilege escalation and process control remain individually classified. |
| Q11 | A | **Accepted:** local session/operation registry and stable IDs, queued/running/completed/unknown states; reconnect queries and no blind replay of side effects. Revoke blocks new dispatch. Handling an existing local process on revoke remains a separate open policy. |
| Q12 | A | **Accepted:** bounded small control messages, paginated output and chunked file transfer with quotas. Actual byte limits, chunk integrity and retention are not yet measured or fixed. |
| Q13 | C | **User-selected but BLOCKED by unresolved contradiction:** VPC routing alone instead of application authentication. This conflicts with accepted #172 (OAuth on `/mcp` and distinct revocable device credential) and Q9/Q10 local approval; a VPC Service routes to host:port but does not identify the remote MCP client or authenticate an individual tool call. No unconditional no-auth adapter/privileged dispatch can be specified. Third-round Q17 must distinguish avoiding an *extra adapter shared token* from discarding client OAuth or local approval; seek an explicit supersession if desired. |
| Q14 | A | **Accepted:** sensitive configuration, global PID, sudo/root and exfiltration actions separately gated or withheld until reviewed; no unconditional raw proxy. |
| Q15 | A | **Accepted:** one Linux/WSL2 device first, local health/audit/receipts, no unproven DO/D1/Queue requirement. |
| Q16 | A | **Accepted:** independent real hosted transport, Linux/WSL2, policy-negative and compatible-client gates, ChatGPT eligibility tracked separately. Mock CI alone cannot close #170. |

### Independent source/evidence and conflict audit (round 2)

1. [Workers VPC service documentation](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/) says a binding routes requests to a **configured host:port** and reduces SSRF surface; it does **not** confer identity or approval on the client that called Worker `/mcp`. Beta/free availability does not imply a secure no-auth local executor. Q13=C is only recorded as a *request*, not an approved security design.
2. The [MCP HTTP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) describes protected server access tokens, validation/audience and discovery when OAuth is supported. #172 deliberately chose independent OAuth-protected `/mcp` and device auth. Dropping all authentication would supersede #172, not merely simplify VPC transport. No such supersession accepted.
3. **Q8 ↔ Q10:** per-action approval for Windows paths cannot restrain a legitimately approved arbitrary Shell, which inherits ordinary WSL2 account privileges. Distinguish direct file-tool admission from unrestricted command effects; options are risk acceptance or optional OS isolation, not a fake directory sandbox.
4. **Q9 ↔ offline work:** when no local human can approve, new sensitive operations fail closed. A queued request may await explicit approval; permission is not automatically assumed from a previously opened connection.
5. **Q10 ↔ Q5:** every *new* Shell launch needs approval, but an interactive session may receive many writes and background side effects. Exact follow-up input/TTL/ownership and detached process policy are third-round concerns.
6. **Q11 ↔ remote retry:** network timeout cannot reveal whether a write/command finished. Persist idempotent operation IDs and explicit `unknown` state locally; status query before any manual retry. Revocation of *future* dispatch is independent of terminating an already-running user process.
7. **Q12 ↔ old CI:** existing 8192-byte caps and fixed-root fixture prove only the read-only transport. Do not silently remove all bounds to implement full file functionality; choose file/control split and budget before higher-permission tests.
8. **Q14 ↔ Q2:** up-to-date tool catalog parity is a coverage goal; a tool can be advertised but gated on risk classification or temporarily disabled pending safe implementation. No upstream `set_config_value` route may disable policy.
9. **Q15 ↔ Q11:** local durable sessions/receipts do not by themselves justify introducing DO/D1 or a whole workflow engine. VPC-vs-DO remains #178's unverified transport decision.
10. **Q16 ↔ #173/#178:** compatible-client acceptance is independent of personal ChatGPT Plus. Hosted VPC and real local-device evidence remain absent. Keep original read-only prototype safety rules.

### Third-round questions — only unresolved authority and lifecycle boundaries, defaults are proposals

**Q17 · What exactly does Q13=C remove?** A = keep #172 OAuth on public `/mcp` and Q9/Q10 local approval, but avoid a **separate long-lived Worker→adapter bearer token** *only if* VPC route ownership, immutable binding/hostname, loopback access control and local call admission can be validated with no weaker effective trust; otherwise retain a minimal revocable device credential (recommended); B = revoke #172's OAuth + device authentication entirely and use VPC routing alone for all layers, accepting that a reachable public Worker `/mcp` would have no client identity (**not acceptable for privileged deployment**); C = keep #172's distinct client OAuth and revocable device credential and let VPC be only private routing; D = custom minimal alternative with explicit actor and local-approval identity. **No version is silently inferred from Q13=C.**

**Q18 · Approval scope for interactive Shell after launch.** A = every new Shell start needs exact local approval; all subsequent stdin affecting commands must be approved separately unless an explicit time-limited session grant with defined command scope exists (recommended); B = once a Shell starts, stdin is unlimited until it terminates; C = no interactive Shell on v1. This cannot be enforced merely by screening `start_process`.

**Q19 · Revocation of active processes.** A = revoke prevents new calls and new stdin immediately; existing managed processes continue but require explicit separate local stop (recommended); B = automatically send TERM and then hard kill managed process group on revoke; C = pause execution pending review if OS-supported and track unknown. No promise to stop arbitrary non-managed host processes.

**Q20 · Approval time and offline.** A = sensitive request stays pending only for a bounded period on the device and fails closed after expiration; approvals bind device, operation hash, nonce and TTL; a one-shot nonce cannot authorize later requests (recommended); B = indefinitely queue and execute when user eventually confirms; C = grant persistent global approval.

**Q21 · Exact audit/receipt retention.** A = bounded local metadata only (operation ID/hash, tool category, decisions, times, state, sanitized error; no raw payloads/secret output), e.g. default 7 days with user configuration (recommended); B = full stdout/file payload saved to cloud by default; C = do not retain receipts.

**Q22 · WSL2 network/Windows reach security expectation.** A = explicit documentation: direct Windows-targeting file tools require approval, yet approved Shell can touch accessible `/mnt/c`/interop; users needing true separation opt into an OS-constrained mode (recommended); B = require OS isolation even though Q1=C chose ordinary account by default; C = assert Windows files are protected by path checks alone (incorrect).

**Q23 · Hosted test ingress while `workers_dev=false`.** A = separately authorized nonpublic Worker-to-Worker Service Binding test entry or similarly verified authenticated-only ingress; ensure no public VPC probe endpoint and capture real binding/tunnel evidence (recommended); B = expose public unauthenticated `/_probe/invoke`; C = treat CI mocked VPC as hosted evidence. Any real test additionally needs actual cloudflared and adapter on Linux/WSL2 and independently provisioned VPC Service.

### Progress and freeze rule
As of these decisions, product scope and user-selected Q13=C are documented; *final auth/transport implementation is blocked.* No new privileged tools, deploy, merge, final to-spec, root issue closure or hosted VPC claim. Keep #178 one active decision frontier and #173/#177 fallback.
