# Remote Desktop MCP：Workers VPC + Tunnel 可行性复核（研究记录）

> 2026-09-23；状态：**research / not approved**。本文件只保存可复核的技术事实和未决问题，不重新开启已按 `not_planned` 关闭的 #170、#173、#178 或 PR #177/#179；不允许据此部署、合并或开启 Shell/写入。研究分支基于 `main`，与 `workflow-mcp-worker` 生产资源隔离。

## 目标与既有决策

目标是在 `apps/remote-desktop-mcp-worker` 规划独立远程 MCP 入口，连接单台 Linux/WSL2 设备上的开源 Desktop Commander MCP（适用工具包括 Shell、文件读写、进程/会话）。不重建私有 Remote Desktop Commander 托管后台。用户已明确 Q1–Q23；此前 Q13=C（仅靠 VPC 路由）的鉴权冲突已经通过第三轮 **Q17=C** 明确解决：保留客户端 OAuth、独立可撤销设备凭证和本地敏感操作审批；VPC 仅负责私有网络路由。见新整理的 [CONTEXT](../remote-desktop/CONTEXT.md)、[decision-log](../remote-desktop/decision-log.md) 和两份 [ADR](../remote-desktop/adr/0001-local-execution-and-authorization.md)。

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
4. 安全与生命周期：Q13 已由 Q17=C 在**决策层**解决，执行时仍须独立验证 OAuth、设备凭证和审批不能被绕过；Q18–Q22 已确定交互 stdin、撤销运行中进程、审批 TTL、元数据审计及 WSL2 风险的方向，具体机制和数字配额仍待规范与负例测试。不能把只读模拟测试当作 Shell/write 验收。
5. 单独验证 OAuth discovery/refresh、MCP 协议版本、Cloudflare Portal 同步、兼容客户端和 ChatGPT 实际权限。按相同只读操作实测延迟、故障恢复和资源消耗，才决定是否替换 DO/WS。

## Grill-with-docs：第三轮决策已确认（2026-09-23）

| 问题 | 选择 | 实施边界 |
| --- | --- | --- |
| Q17 | C | 保留公共 `/mcp` OAuth、独立可撤销的设备凭证、设备本地审批；VPC 仅路由。**明确取代历史 Q13=C 的无鉴权解释**，与 #172 一致。 |
| Q18 | A | 新任意 Shell 启动逐次审批；可执行新命令的 stdin 再次审批，或需要明确的限时/限范围 session grant。 |
| Q19 | A | 撤销立即拒绝新调用及 stdin；正在运行的受管理进程继续，必须另行本地停止，不自动 kill 任意 PID。 |
| Q20 | A | 敏感审批在设备端限时等待，绑定设备、操作哈希、nonce 和 TTL；离线、过期、重放均 fail closed。 |
| Q21 | A | 只保留本地有界元数据（ID、摘要、时间、状态、脱敏错误）；建议可配置默认 7 天，不默认存云端原始文件/stdout/凭证。 |
| Q22 | A | 明确承认获批 Shell 可能间接访问 `/mnt/c` 与 Windows interop；直接 Windows 文件工具单独审批；真正隔离提供可选 OS 约束模式。 |
| Q23 | A | 真实 hosted 验证只能使用经过授权的非公开 Service Binding 测试入口或同等认证入口，不开放无鉴权公网 probe。 |

以上是**产品及安全决策**，不是实际实现/测试通过的证据，也未选定 VPC 优于 DO/WS。原 [第三轮题面](https://github.com/lirtual/mcp-workers/blob/prototype/remote-desktop-vpc-178/.scratch/remote-desktop-vpc/GRILL-WITH-DOCS.md) 和旧 PR 保持历史不变；新研究分支统一归档 [CONTEXT](../remote-desktop/CONTEXT.md)、[decision-log](../remote-desktop/decision-log.md)、[执行与认证 ADR](../remote-desktop/adr/0001-local-execution-and-authorization.md)、[本地会话 ADR](../remote-desktop/adr/0002-local-session-and-bounded-transfer.md)。

## 真实 VPC 验收计划（未执行）

| 阶段 | 责任和操作 | 通过标准 / 必留证据 |
| --- | --- | --- |
| G0：准备与授权 | 核对 Cloudflare 账号是否有 Connectivity Directory Admin 和 Bind 权限、是否可用 Beta；用户独立批准任何测试资源创建；固定测试 HEAD、零生产资源变更。 | 权限、成本和独立资源清单；无授权/不满足 Free 预期即停止，不用公开 Tunnel 降级伪装通过。 |
| G1：设备只读环境 | 用户在自己的 Linux/WSL2 上启动固定 root 的只读 HTTP→Desktop Commander stdio adapter，`cloudflared >= 2025.7.0` 且 QUIC/auto、UDP 7844 可用；确认二者共享 namespace 时 `localhost` 才有效。 | 端口、进程版本、绑定监听与 Tunnel health 脱敏记录；不接入宿主 Shell/写入。 |
| G2：实际 hosted 网络 | 经单独授权创建私有 Tunnel、VPC Service exact host:port、独立 Worker/VPC binding；通过非公开或认证测试入口调用真实 `env.PRIVATE_DEVICE.fetch()`。 | 固定只读 `ping` 与一次实际 Desktop Commander 目录读回环；记录 Cloudflare 资源 ID（内部）、HEAD、时间、脱敏结果及指标。绝不以 mock 或公网 Published Application 替代。 |
| G3：安全负例与恢复 | 测试无效客户端/设备凭证、非法工具/路径/参数、超长请求及响应、超时、Tunnel/adapter 断开恢复、凭证撤销和审批拒绝。 | 全部 fail closed；断线后状态可查询；无法确定的副作用不得自动重放。测试仍须处于只读隔离环境。 |
| G4：MCP 客户端 | 实测 OAuth discovery/refresh、当前协议版本、Portal sync、兼容 MCP 客户端；ChatGPT 实际工具权限独立记录。 | 客户端能够完成有权限的只读操作；不以兼容客户端成功推断个人 ChatGPT Plus Shell/write。 |
| G5：选型与 Spec 闸门 | 使用相同只读调用比较真实 VPC 与历史 DO/WS 的延迟、故障恢复、维护、免费计划和实际限制；复核本地授权/配额/工具 catalog。 | 证据足够才写最终 transport ADR/考虑 to-spec。高权限操作需另行授权和独立负例验收，不能由 G2/G3 的只读通过自动开启。 |

## 冲突复核与剩余问题

1. **Q13 vs #172：已解决**，Q17=C 明确三层分离；不得静默删除设备凭证或本地审批。
2. **普通账号 Shell vs 项目/Windows 范围：风险仍存在但已明示接受**，单次审批不是 OS sandbox；确需隔离须选择真正受限账号/容器/VM。
3. **启动审批 vs stdin / 撤销 vs 已运行进程：规则已明确**，但仍需要实际工具级、并发及跨重连测试；撤销不能撤销已发生的副作用。
4. **7 天审计、TTL、分块配额：仅方向确定**；精确数字、存储寿命、one-shot nonce 原子性、chunk checksum 与 Desktop Commander 版本工具矩阵仍待实测。
5. **VPC / ChatGPT：仍无真实证据。** 上次只读 Cloudflare 查询是 0 VPC Services、两个旧 Tunnel 均 down；本轮未创建资源或部署。个人 ChatGPT 能调用哪些工具必须独立确认。

**结论：决策已收敛，文档级架构可行；真实 VPC 和客户端仍未验收，最佳方案未定。当前严格冻结部署、合并和高权限工具。**

## G0 执行记录（2026-09-23）

**Owner 同意按 G0–G5 继续，但不取消部署/合并/高权限冻结。** 这一轮已实际重新读取 GitHub 文档分支的精确 HEAD `980d4ef19a0e50ba83ff3896dc1088e7d8789483`，并再次确认 #170/#178 为 `closed/not_planned`、PR #179 为 `closed/unmerged`；保留既有证据，不恢复工单或原型部署。原型 `wrangler.jsonc` 的 `service_id=00000000-0000-4000-8000-000000000000` 为无效占位符，`workers_dev=false`，`preview_urls=false`，不可当作真实 Cloudflare VPC。

通过 Cloudflare 官方页面重新核查（2026-09-23）：
- [Pricing](https://developers.cloudflare.com/workers-vpc/platform/pricing/)：Open Beta 期间 VPC 免费，常规 Workers 请求/CPU 仍计入计划；不可承诺 GA 后永久免费。
- [VPC Services](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/)：`Connectivity Directory Admin` 用于创建，`Connectivity Directory Bind` 用于绑定；是否具备权限**必须由本账号实际验证**。
- [Tunnel](https://developers.cloudflare.com/workers-vpc/configuration/tunnel/) / [Troubleshooting](https://developers.cloudflare.com/workers-vpc/reference/troubleshooting/)：设备需兼容的 `cloudflared`、QUIC、出站 UDP 7844，且实际服务地址/端口可被同一网络命名空间中的连接器访问。
- [Binding API](https://developers.cloudflare.com/workers-vpc/api/)：登记的 host:port 才是实际路由目标；不可凭 Worker `fetch` 的 URL 假定变更目标。

**当前阻塞项：本轮运行环境没有可调用的 Cloudflare 账号连接工具，也没有设备侧执行工具。** 通过插件目录查询未找到可用的 Cloudflare 连接。此处不能据上一轮账号快照（0 Service、两条 Tunnel down）声称“最新仍为 0”，也不能验证 Create/Bind 权限，更不能创建独立 Tunnel、Service 或执行真实设备回环。未请求账号密钥、未做修改。

### G0 剩余检查（可直接交给设备侧 agent 或恢复 Cloudflare 连接后执行）

1. 先只读确认当前 Cloudflare 账号、Workers Free 状态、Connectivity Directory 的 Admin/Bind 权限及 Beta 功能入口；如角色未知，明确记录为 `unknown` 而不是用创建 API 试权限。不能获得授权/确认 Free 时停止。
2. 再只读列出现有 VPC Services 和 Tunnels，记录是否存在已经被其他应用占用的资源。旧 `grokbot`/`tsvc` 不得重用/删除/改变。
3. 设备侧只读收集 `uname -a`、`cloudflared --version`、`node --version`（若已安装）、`ss -lnt` 与出站 UDP 7844 网络是否允许；输出只保留必要的版本、命名空间和端口信息，不回传 Tunnel token 或主机私密文件。
4. 确定独立测试命名和只读目录之后，**经过独立授权**才允许创建专属 Tunnel 与 VPC Service；不能直接部署旧 #179 的占位配置。G2 如需真正运行一个隔离探针 Worker，必须先核对 Q23 的非公开入口与单独授权；本轮未运行任何探针。

**G0 状态：官方条款和 GitHub 证据已核查；账号实时资源/权限与设备实况未验证，G1–G5 未开始。**

## G0 复核：Cloudflare 连接恢复（2026-09-23 09:51 +08:00 后）

本节是上一轮 G0 记录的**后续进展**，取代上文“本轮没有可调用的 Cloudflare 连接”的当前阻塞判断；保留原记录作为时间线。使用用户明确 @Cloudflare 授权的连接器，仅执行 `GET`，没有创建/修改资源、部署 Worker、启用高权限工具或读取敏感凭证。

| 只读接口 | HTTP/API 结果 | 可采信事实 |
| --- | --- | --- |
| `GET /accounts/{account_id}/connectivity/directory/services` | 200 / success | VPC Services **0**；因此没有可绑定的真实 Service。 |
| `GET /accounts/{account_id}/tunnels` | 200 / success | 2 条：`grokbot` / `tsvc`，均 `down`，不复用和不修改。 |
| `GET /accounts/{account_id}/members` | 200 / success | 两个成员均为 `Super Administrator - All Privileges`；无法从成员角色推断**当前连接器的 API 凭证**必定具有 VPC Admin/Bind。 |
| `GET /accounts/{account_id}/workers/scripts` | 200 / success | 没有名字匹配 `desktop` 或 `vpc` 的 Worker；仅为名字筛选，不表示不存在其他相关部署。 |
| `GET /accounts/{account_id}` | 200 / success | 账号类型为 `standard`，**不是 Workers 的付费层级证据**。 |
| `GET /accounts/{account_id}/workers/account-settings` | 200 / success | `default_usage_model=standard`，**不是订阅计划证明**。 |
| `GET /accounts/{account_id}/subscriptions` | API 10000 | 认证错误；无法核实计划。 |
| `GET /user/tokens/verify` / `GET /user/tokens/permission_groups` | API 1000 / 9109 | 本连接器凭证不支持这些读取路径，不能据此推断 VPC 写入权限或断言全部 Cloudflare API 失效。 |

[Cloudflare 官方 VPC Services](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/) 确认 Open Beta 期间 Free 和 Paid Workers 计划均可使用，创建需 `Connectivity Directory Admin`、绑定需 `Connectivity Directory Bind`；[VPC Networks](https://developers.cloudflare.com/workers-vpc/configuration/vpc-networks/) 可绑定整个 Tunnel/网络，比固定 host:port 的 Service 范围宽。**单台敏感设备坚持优先验证固定目的地 VPC Service**，不因 Network 的灵活性扩大可访问网段。

**更新后的 G0 判定：** 账号与服务的只读可见性已通过；VPC Admin/Bind 对当前连接器凭证仍为 **unknown**，实际 Workers 计费计划未证实，专属测试 Tunnel/Service 均不存在，设备上的 `cloudflared`/adapter/UDP 7844 未核验。因此 **G0 未全部通过，G1/G2 尚不能声明完成**。

**下一步：** 在 Linux/WSL2 设备进行不含凭证的只读环境检查；明确计划与 Create/Bind 权限（不要通过无效创建请求试错）；设备侧只读 Adapter 准备好并单独授权隔离资源创建后，才能建立专属 Tunnel 和 VPC Service。不要以当前 0 Services、旧 Tunnel down 代替真实网络失败结论；也不要因 G0 已可读就解除部署/合并/高权限冻结。
