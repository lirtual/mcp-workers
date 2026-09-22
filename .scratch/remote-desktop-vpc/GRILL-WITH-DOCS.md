# #170 Remote Desktop MCP — grill-with-docs, round 1 (PROVISIONAL)

Date: 2026-09-23. **Interview in progress, not an approved Spec, ADR, or production permission.** Source issue [#170](https://github.com/lirtual/mcp-workers/issues/170); one active transport decision [#178](https://github.com/lirtual/mcp-workers/issues/178), throwaway Draft [#179](https://github.com/lirtual/mcp-workers/pull/179). The separate legacy DO/WS proof [#173](https://github.com/lirtual/mcp-workers/issues/173) / Draft [#177](https://github.com/lirtual/mcp-workers/pull/177) remains available.

## Actively settled requirement
The user requires **Shell and write actions and full applicable local Desktop Commander MCP capability**, rather than shipping a permanently read-only two-tool service. The prior `sandbox_ping` / fixed-root `sandbox_list_directory` CI is a deliberately narrow **transport feasibility gate**, and must not be treated as the final tool contract. This requirement does not authorize executing high-privilege tools before an isolation and approval strategy is agreed and tested.

## Primary-source recon
1. [Desktop Commander upstream README/tool catalog](https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/main/README.md): interactive terminal/session management, process listing and termination, file read/write/move/search, editing, configuration, usage/history. Upstream evolves; the pinned `@wonderwhy-er/desktop-commander@0.2.51` fixture is not proof of the current latest tool catalog. Its Claude-specific preview UI, if any, cannot be promised in ChatGPT.
2. [Upstream SECURITY.md](https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/main/SECURITY.md): `allowedDirectories` and blocked command lists are not hard isolation against arbitrary Shell. Restrict by dedicated OS account, container mounts, VM, or dedicated device. `set_config_value` and any process-wide `kill_process` demand their own policy review.
3. [OpenAI full MCP support and permissions](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt): full modify/write beta for Business/Enterprise/Edu; Pro is read/fetch; do not assume personal Plus has arbitrary remote Shell permission. Real client validation is a separate gate. OAuth refresh/offline access and client confirmation requirements are independent of private VPC.
4. [Workers VPC Service](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/) and [Tunnel](https://developers.cloudflare.com/workers-vpc/configuration/tunnel/): VPC service is transport limited to configured host/port, **not a tool authorization policy**. Free during beta only. QUIC and actual device connectivity still need proof.

## Target capability inventory — check exact pinned upstream names/schemas before Spec
- File: read/write/append/edit/move/create/list/metadata; search files and content; supported format-specific PDF/Excel/DOCX operations as provided by selected upstream release.
- Terminal: start, interact, read paged output, list sessions, stop sessions.
- Process: inspect/list; terminate managed process; arbitrary PID termination is a distinct privilege.
- Configuration and diagnostics: inspect config and bounded tool-call history. Changing security-sensitive settings is not ordinary task execution.
- Device operations beyond upstream: health/capability inventory, disconnect/revoke, operation receipts/correlation, status after reconnect, bounded outputs and artifact retrieval, audit and credential rotation. These are candidate supporting features, not yet agreed standalone products.
- GUI desktop capture, cursor/mouse/keyboard automation, proprietary cloud dashboard and all-Supabase emulation are **not implied** by upstream's terminal/file tools; separate scope decision needed.

## Unresolved round-1 choices (defaults are proposals, not decisions)
Q1 Execution scope: A dedicated low-privilege OS account with user-selected writable project directories (proposed); B strictly mounted container/VM workspace; C ordinary desktop login with broad host permissions.
Q2 Tool parity: A expose upstream core tool catalog with locally gated privileged configuration/global PID actions (proposed); B transparently proxy every tool including security config by default; C fixed reduced subset.
Q3 Approval: A automatic read, configured project-write policy, confirmation for Shell/destructive/privileged actions with time-limited scope (proposed); B approval for each write/Shell; C one-time broad approval.
Q4 Device scope: A Windows-first and Linux parity later (proposed); B Windows and Linux both on initial release; C one OS only.
Q5 Process/lifecycle: A local long-running interactive sessions, explicit stop/status, scoped resource and output quotas (proposed); B only one-shot commands.
Q6 Client acceptance: A insist on personal ChatGPT Plus Shell/write as a hard gate despite current restriction; B deliver secure remote MCP to permitted clients, separately validate ChatGPT read-only or future Full MCP (proposed); C require switching to a plan/workspace that supports Full MCP before calling product accepted.
Q7 Capability extras: A add minimal device health, audit, revoke and safe operation receipts without turning into an orchestration platform (proposed); B full custom GUI/remote desktop/scheduling; C no supporting extras.

## Gates that cannot be inferred from read-only CI
- Real Windows/Linux privileged tool use and hard kill, unrestricted-path/symlink escape, config mutation, secret access and PID control negative tests.
- Large result / long-running session protocol, reconnect exactly-once/retry semantics; old 8192-byte proof does not define final file/command size.
- Cloudflare VPC/Tunnel real routing and beta/Free operations; OAuth discovery/refresh; actual ChatGPT user entitlement and action confirmation.
- Final selection VPC versus DO, version strategy, native host/VM and approval architecture must await decisions and evidence.

No ADR issued at this stage: transport, privileges, approval and exact tool-surface decisions remain open. Keep #178 frontier single; avoid mixing feature-scope grilling with a premature transport verdict.
