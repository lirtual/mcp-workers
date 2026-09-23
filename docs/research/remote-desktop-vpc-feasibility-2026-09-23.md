# Remote Desktop MCP：Workers VPC + Tunnel 可行性复核（研究记录）

> 2026-09-23；状态：**research / not approved**。本文件只保存可复核的技术事实和未决问题，不重新开启已按 `not_planned` 关闭的 #170、#173、#178 或 PR #177/#179；不允许据此部署、合并或开启 Shell/写入。研究分支基于 `main`，与 `workflow-mcp-worker` 生产资源隔离。

## 目标与既有决策

目标是在 `apps/remote-desktop-mcp-worker` 规划独立远程 MCP 入口，连接单台 Linux/WSL2 设备上的开源 Desktop Commander MCP（适用工具包括 Shell、文件读写、进程/会话）。不重建私有 Remote Desktop Commander 托管后台。此前用户已明确 Q1–Q16（参见原 [decision log](https://github.com/lirtual/mcp-workers/blob/prototype/remote-desktop-vpc-178/.scratch/remote-desktop-vpc/decision-log.md)）；Q13=C（仅依赖 VPC 路由）与 #172 的客户端 OAuth 和可撤销设备凭证存在冲突，**不得作为已批准的鉴权方案**。原第三轮 Q17–Q23 仍待定。

2026-09-23 GitHub 读取确认：[根工单 #170](https://github.com/lirtual/mcp-workers/issues/170) 和 [VPC 决策工单 #178](https://github.com/lirtual/mcp-workers/issues/178) 已 `closed/not_planned`；[DO/WS PR #177](https://github.com/lirtual/mcp-workers/pull/177) 和 [VPC PR #179](https://github.com/lirtual/mcp-workers/pull/179) 均关闭且未合并。前者为本地只读 DO/WS proof，后者仅为 *mocked VPC binding* 下 4/4 isolated tests；没有真实 VPC、设备或 ChatGPT 能力验收。

## 官方事实与来源

| 项目 | 核查结果 | 一手资料 |
| --- | --- | --- |
| VPC 的作用 | VPC Service 将 Worker `fetch` 限定到已登记的私有 host:port，经 Cloudflare Tunnel 路由；VPC 不代替客户端身份验证或设备操作批准。 | [VPC Services](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/) / [Binding API](https://developers.cloudflare.com/workers-vpc/api/) |
| 网络前提 | 必须运行连向 Cloudflare 的 `cloudflared`；不要求设备公网 IP/入站端口。需 `cloudflared >= 2025.7.0`、`auto` 或 `quic`，允许出站 UDP 7844。HTTP origin 可是本机端口，但 `localhost` 仅在 cloudflared 与 adapter 共享网络命名空间时等价。 | [Tunnel](https://developers.cloudflare.com/workers-vpc/configuration/tunnel/) / [Get started](https://developers.cloudflare.com/workers-vpc/get-started/) |
| 权限 | 创建 VPC Service 需 Connectivity Directory Admin；将现有 Service 绑定到 Worker 需 Bind 权限。单有 Read 和成功的 API 查询并不证明有写权限。 | [VPC Services](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/) |
| 计费 | Workers VPC 目前 Open Beta 期间免费，不代表 GA 后永久免费；Workers Free 常规额度依然适用。 | [VPC pricing](https://developers.cloudflare.com/workers-vpc/platform/pricing/) / [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Workers Free 限制 | 100,000 请求/天，10 ms CPU/请求，128 MB 内存，50 次子请求/调用；HTTP 请求连接持续时无固定 wall-time 上限，但断连和运行时更新影响长调用。CPU 是实际运算时间而非网络等待时间。 | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| 本地执行边界 | Desktop Commander `allowedDirectories` 和命令 blocklist 不是 Shell sandbox；如需真正限制主机权限，应采用 OS 级隔离。之前用户选择普通 Linux/WSL2 账号，意味着授权 Shell 能访问该账号可达资源，包括可能的 Windows 挂载和 interop。 | [Desktop Commander SECURITY](https://github.com/wonderwhy-er/DesktopCommanderMCP/security) |
| ChatGPT 客户端 | OpenAI 当前文档对 Full MCP（含 write/modify）的明确覆盖是 Business、Enterprise/Edu，Pro 可用 read/fetch；不能假定个人 Plus 可以直接执行完整 Shell/写入，须通过实际客户端/计划权限单独验收。 | [OpenAI developer mode / MCP](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt) |

## 当前账号只读核查

2026-09-23 API `GET /accounts/{account_id}/connectivity/directory/services` → HTTP 200，0 个 VPC Service；`GET /accounts/{account_id}/tunnels` → HTTP 200，现有 `grokbot`、`tsvc` 均 `down`。这不能当作真实设备 VPC 已准备好。不得借用原生产 `workflow-mcp-worker` 资源。

## 候选架构与设计判断（待实测，不是最终 ADR）

```text
Compatible MCP client / ChatGPT
   -> OAuth-protected remote-desktop-mcp-worker /mcp
   -> restricted VPC Service binding (private host:port)
   -> Cloudflare Tunnel (outbound cloudflared)
   -> loopback HTTP adapter on Linux/WSL2 (local admission, approval, receipt)
   -> pinned local Desktop Commander MCP over stdio
   -> local user-permission Shell / files / sessions
```

Worker 做 MCP 入口、OAuth、工具策略、短请求路由及上限；本地 Adapter 负责真正授权、stdio、稳定 operation/session ID、日志分页、分块传输、撤销和断线状态。不要把 Shell 运行放在 Worker，也不要为单设备无条件引入 D1、Queue 或 DO。若实际 hosted VPC 不可用，再用旧 DO + WebSocket 原型比较与回退。VPC 路由只能到固定目的地址，不可用来证明来自公网 MCP 调用者身份；无本地确认的敏感命令 fail closed。

## 必须先验证的证据闸门

1. 独立测试资源：Cloudflare 账号具备 Create/Bind 权限；新建独立 Tunnel + HTTP VPC Service、非生产 Worker；保留真实 ID、配置与 HEAD 的脱敏证据。不以公开 Tunnel Published Application 替代私有 VPC。
2. 设备侧：同一 Linux/WSL2 环境的 `cloudflared` 和 loopback adapter，固定只读 root，确认实际监听地址/namespace、QUIC 和 UDP 7844。
3. 端到端：真正 `env.PRIVATE_DEVICE.fetch()` → 私网 adapter → 固定只读 Desktop Commander stdio → 响应；负例涵盖坏凭证、非法 tool/参数、超限、超时、掉线/恢复、撤销。
4. 安全与生命周期：先消除 Q13 鉴权冲突，再定义审批与交互 stdin、撤销进行中的进程、重试 unknown、WSL2 Windows 挂载的真实风险、配额/日志保留；不能把只读模拟测试当作 Shell/write 验收。
5. 单独验证 OAuth discovery/refresh、MCP 协议版本、Cloudflare Portal 同步、兼容客户端和 ChatGPT 实际权限。按相同只读操作实测延迟、故障恢复和资源消耗，才决定是否替换 DO/WS。

## Grill-with-docs：承接原第三轮，而非重复已决问题

[原 Q17–Q23 全文](https://github.com/lirtual/mcp-workers/blob/prototype/remote-desktop-vpc-178/.scratch/remote-desktop-vpc/GRILL-WITH-DOCS.md) 仍适用。尤其先回答 **Q17：是否仅移除额外 Worker→Adapter 长期 token，而保留 /mcp OAuth + 本地审批？** 建议 C（保持两层可撤销身份 + VPC 只负责私网路由）；如果选择 A，需先证明同等信任边界。Q18–Q23 分别对应交互 Shell stdin、撤销运行中进程、审批 TTL/离线、审计留存、WSL2 Windows 文件边界、非公开 hosted 测试入口。

**当前结论：文档级可行；本账号尚未建立实际 VPC 连接，未证明 hosted 端到端；“最佳”只能在这些证据闸门完成后确定。**
