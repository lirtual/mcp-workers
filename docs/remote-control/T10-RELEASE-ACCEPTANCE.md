# Remote Control MCP — T10 离线发布验收材料

**状态：2026-10-13 只读线上验收已通过，但 T10 整体发布验收尚未完成。下方历史离线材料保留原始证据边界。**
**历史离线核对基准：** `main` 提交 `caf10c36745ee2d03f24851e89541ea2d343d8d3`，日期 2026-10-12；线上只读验收基准见下文增量记录。
**Issue：** [T10 #12](https://github.com/lirtual/mcp-workers/issues/12)（保持 Open）；父规格 [#2](https://github.com/lirtual/mcp-workers/issues/2)（保持 Open）。

本文整理代码交付证据、发布前检查、回滚和撤销步骤。没有 Cloudflare、Portal 或真实主机访问授权；表中的真实环境项均为待验收，不得据此声称生产可用。T07 的账户风险接受也不等于 T09 进程停止竞态已获准。

## 2026-10-13 线上只读验收增量

**状态：只读版本已完成真实 Worker 级和 ChatGPT/Portal 端到端验收；T10 整体验收尚未通过，#12 / #2 继续 Open。**

本节证据晚于下文 2026-10-12 的**历史离线材料**。下文“未部署/未核对”等表述描述当时状态，不能再用作当前环境现状。

| 核查对象 | 已确认结果 | 证据边界 |
| --- | --- | --- |
| 发布代码 | Git SHA `1c24572e43e05ab8b6f40375651e6fb5cf7d6a97` | GitHub main |
| 线上 Worker | `remote-control-mcp-worker` Version ID `4161e117-4f04-48db-aad6-6daf68b17981`，100% 流量 | Cloudflare 部署 API |
| 原生 Agent | Node.js `24.21.0`、loopback `127.0.0.1:9477`、UID 1000 | 设备发布记录；无 Shell 实际执行授权 |
| 私有连接 | VPC Service `01a12f13-7963-7241-bc38-3efba612d17e` 指向新 Tunnel `c1faea11-7194-4d20-a71d-97acd9555e6f`，新 Tunnel healthy、2 连接 | 发布记录与 Cloudflare Tunnel API |
| 离线/线上检查 | Agent `23/23`、Worker `12/12`、类型检查通过；Worker 线上 `25/25` | 设备上的 `release-20261013/RELEASE.md`，验证时间 `2026-10-13T03:17:05Z`，已使用真实插件只读读取 |
| Portal / ChatGPT | Portal 中 `remote-control` 已启用；当前可见设备操作仅 `read_file`；真实 ChatGPT 调用读取 `/tmp/remote-control-t02-fixture/marker.txt`，返回 **`remote-control-t02-marker`** 且无 HTTP/工具错误 | 2026-10-13 实际连接器调用；见 [T10 增量验收评论](https://github.com/lirtual/mcp-workers/issues/12#issuecomment-6137873423) |
| 只读保护 | `REMOTE_CONTROL_ENABLE_FILE_WRITES=false`、`REMOTE_CONTROL_ENABLE_SHELL=false`；直接调用隐藏能力被拒绝 | 设备发布记录中的 Worker 线上验收及真实插件可见工具范围 |

**未核销的 T10 门槛（不可据此关闭 #12）：**

1. 独立 ingress / device 凭证的实际轮换、撤销和旧凭证失效测试，及其他 MCP Workers 不受影响的验证；需要单独授权，严禁记录凭证值。
2. Agent 日志、回执持久化目录和文件权限、保留策略、session 输出以及基础设施日志的完整核对。当前发布报告明确未完成全量基础设施日志审查。
3. 停服、重启自动恢复及已知版本回滚的真实操作验收。当前 Agent 与 Tunnel 是独立用户进程，尚无新安装的开机服务管理器；`before.json` 保存了变更前配置，**回滚未执行或测试**。
4. owner 的最终发布决定，T07 账户风险的上线复核，以及 T09 PID/PGID 复用 TOCTOU 风险专项裁决；上述只读验收**不授权**文件修改或 Shell。

本轮 T10 文档更新只登记可验证的只读发布事实与未完成项，**不**触发凭证更改、Worker/Agent/Tunnel 重启、Portal Sync、文件修改或 Shell 授权。

## 2026-10-13 无中断元数据与配置复核

本轮仅通过已授权的只读 Remote Control MCP 工具与 Cloudflare/GitHub 只读 API 核验，**未访问任何真实凭证值、回执正文或敏感业务文件**，也未停止进程、切换代理/隧道、轮换凭证或执行 Shell。

| 检查项 | 实际观测 | 验收归类 |
| --- | --- | --- |
| Agent 实时进程元数据 | 通过 Agent `read_file(/proc/self/status)` 返回 `Tgid/Pid=495681`、`Uid=1000/1000/1000/1000`、`Gid=1000/1000/1000/1000`；与发布记录的 Agent PID 495681 一致 | **已核实**：当前 Agent 以非 root 身份运行；不能由 UID 推出其 Linux 权限隔离充分 |
| 回执目录 | `/home/ray/.local/state/mcp-workers/remote-control-agent`，设备 `get_file_info` 返回目录、`mode=0700` | **已核实**：权限位；工具未返回文件所有者 UID |
| 回执文件 | 上述目录中的 `operation-receipts.json`，设备 `get_file_info` 返回常规文件、`mode=0600`、大小 340 字节；目录列表只有该文件 | **已核实**：权限位、文件存在；没有读取回执内容，不能推断记录数量、状态或实际清理历史 |
| 发布证据目录与文件 | `release-20261013` 目录 `0700`；`remote-control-agent-test.log` 和 `acceptance-online.json` 元数据均为 `0600` | **已核实**：本次证据文件权限位；未读取具体测试日志或线上日志内容 |
| Worker 线上只读门控 | Cloudflare Worker Settings API 中 `REMOTE_CONTROL_ENABLE_FILE_WRITES` 和 `REMOTE_CONTROL_ENABLE_SHELL` 均为 `plain_text: false` | **已核实**：当前配置仍维持只读 |
| Worker 观测配置 | Cloudflare Settings API 返回 `observability.enabled=true`、`head_sampling_rate=1` | **配置已核实**：未读取实际 Cloudflare 日志事件、内容、保留时间或日志投递路径 |
| Agent 日志契约 | 当前源码 `main.ts` 只将 `service/event` 写入 stderr；`server.ts` 调用固定事件名；Worker `worker.ts` 仅记录白名单事件 | **源码审计**：不能代替对所有真实 stderr、Cloudflare 平台日志或外部转发日志的内容检查 |
| 回执与 Session 有界性 | 当前源码 `operations.ts`：最多 1000 条、终态 30 天、未知结果不自动重放；`sessions.ts`：最多 10 Session、每个输出 256 KiB、结束后 30 分钟缓存 | **源码审计**：策略在代码中存在，未做长期真实保留/清理行为测试 |

本轮明确剩余的安全与生命周期验收缺口：文件所有者 UID（当前工具仅返回 mode）、Agent stderr 和 Cloudflare 平台的实际日志与投递/保留、回执生命周期的实测清理、独立 ingress/device 凭证的撤销与旧值失效、独立用户进程重启后的自动恢复安排、生产回滚演练和 owner 最终发布决定。上述未验证项不应因权限位符合设计而标记为通过。T10 #12、父规格 #2 仍保持 Open，真实文件修改及 Shell 均未获授权。

## 历史离线结论与当时门槛（2026-10-12）

离线代码验收证据已经覆盖 T01R–T09 的实现切片；历史真实联调只证明早期只读版本。当前 `main` 中的 Worker、Agent、Tunnel、VPC Service 和 Portal capabilities 是否与生产一致尚未核实。Worker 的 Wrangler 配置仍含占位 VPC Service ID，不能直接部署。T10 不得因本文件或票据状态关闭。

以下事项仍须在真实环境分别获准并记录结果：

- 核对线上 Worker Version ID、绑定、两个远程控制凭证的存在状态、Tunnel/VPC Service 目标和 Portal tool list；不输出任何密钥值。
- 验证当前 Portal/ChatGPT ingress、凭证轮换及撤销、Agent 生命周期和权限、固定私有网络路径、断网失败行为、回执/日志/输出权限与清理。
- 文件写入需要单独的目标与操作授权。Shell 启用需要单独发布决定；T07 风险接受不覆盖 T09 的 PID/PGID 复用 TOCTOU 风险。
- 记录验证日期、操作者、目标、代码 SHA、Worker Version ID、Agent Node.js/runtime 版本、测试和结果；失败或未验证项保持显式。

## Worker 默认只读门控

Worker 保留全部离线文件修改和 Managed Session 实现，但线上工具默认只公开只读能力。文件修改仅在 `REMOTE_CONTROL_ENABLE_FILE_WRITES` 精确设为 `true` 时公开；Shell 会话工具仅在独立的 `REMOTE_CONTROL_ENABLE_SHELL` 精确设为 `true` 时公开。缺失、`false` 或其他值均保持关闭；即使调用方直接提交隐藏工具名，Worker 也会拒绝并且不转发给 Agent。离线测试只有在一次性 fixture 中显式打开所需门控。

这两个门控是独立部署开关，不代替具体文件目标/操作授权、T07 账户复核或 T09 PID/PGID TOCTOU 风险裁决。只读联调不得设置任一开关；启用任一门控须作为对应能力的单独发布决定记录。

## T01–T09 证据矩阵

证据来源是各 GitHub Issue 的交付评论和当前仓库代码；这是一份离线汇总，不是对旧测试的复跑。较早评论没有记录 Node.js 版本时标为“未记录”。

以下交付评论均记录于 2026-10-12；若评论未明确测试运行日，该日期只表示证据记录时间，不应误写成测试实际运行日期。后续真实验收记录须填写实际测试日期。

| 切片 | 代码/决定证据 | 已记录的离线或真实证据 | 测试实际运行日 | 当前仍待确认 |
| --- | --- | --- | --- | --- |
| T01 #3 / T01R #13 | `ce2bb82` 历史只读 Worker/Agent；迁移在 `287ce6f` 用 Node 原生实现替换 Desktop Commander | #3 记录 Worker/Agent 类型检查和测试通过；#13 记录迁移后检查通过、标准与规格审查通过 | 未记录；GitHub 交付评论日期为 2026-10-12 | #3 是历史切片；#13 评论没有给测试数或 Node 版本。当前运行中的 Agent 版本未核实 |
| T02 #4 | `cabc9b3` 只读 Portal/ChatGPT 联调记录 | GitHub 记录旧版 Worker `c603cdc1-0c92-4d1c-9b79-eb39ff0e73a2` 和只读 Agent 经 Portal 成功读取一次性 fixture；401/403、设备凭证错误和 Tunnel 断开路径也有记录 | 未记录；GitHub 交付评论日期为 2026-10-12 | 这是旧只读版本的证据，不证明当前 `main` 已部署、当前 Portal capabilities 已同步，亦不覆盖写入/Shell |
| T03 #5 | `a2da840` 有界目录/批量读取 | Agent/Worker 类型检查和测试命令通过（测试计数与 UID 1000 用例未在 #5 评论记录）；评论记录部署 Worker `f28b23b0-358f-4151-b58b-4e1050bf13c1` | 未记录；GitHub 交付评论日期为 2026-10-12 | 测试 Node 版本未记录。此 Worker Version 是历史部署证据，不代表当前线上版本 |
| T04 #6 | `2d1421a`、`35b90ed`、`56ebc61`、`9bdd844` 分页搜索与断连处理 | Agent 10/10、Worker 7/7、类型检查及标准/规格审查通过；一次性 fixture | 未记录；GitHub 交付评论日期为 2026-10-12 | 评论未记录 Node 版本；无当前线上部署证据 |
| T05 #7 | `32305610d9e442d2dd23df50d934886727a84f32` | Agent 16/16、Worker 8/8；一次性 fixture、UID 1000 权限拒绝；回执重启恢复及去重覆盖 | 未记录；GitHub 交付评论日期为 2026-10-12 | 历史报告注明当时未在 Node 24 环境重跑；不能由旧测试推出线上 `write_file` 已开放 |
| T06 #8 | `968a4b4aed56993fb24c030580a6f034dc4224d6` | Node 24.21.0；Agent 17/17、Worker 9/9；四项生产/测试 TypeScript 检查通过；一次性 fixture 与 UID 1000 权限拒绝 | 未记录；GitHub 交付评论日期为 2026-10-12 | 未部署 Worker；真实文件写入未验收 |
| T07 #9 | GitHub 记录 WSL2 `ray`（UID 1000）只读账户核查及 owner 风险接受 | 记录 `sudo -n` 失败、`docker` 组与 socket 权限、可读凭证候选元数据、WSL DrvFs/interop 边界；未读凭证内容、未改系统权限。Node 24.21.0 下当时 Agent/Worker 26/26、四项类型检查通过 | 未记录；GitHub 交付评论日期为 2026-10-12 | 该接受不构成主机隔离，不代表部署/Shell 授权；完整 sudoers、Docker daemon 后端及 Windows ACL 等仍有范围限制 |
| T08 #10 | `a930b89bf031dccb13c56ba0918fdc47bba5f04f` | Node 24.21.0；Agent 20/20、Worker 9/9；一次性 process fixture；回执、会话重启与关闭路径 | 未记录；GitHub 交付评论日期为 2026-10-12 | 未部署、未开放线上 Shell；进程组清理有界且不能保证清理逃逸进程 |
| T09 #11 | `caf10c36745ee2d03f24851e89541ea2d343d8d3` | Node 24.21.0；Agent 23/23、Worker 9/9；Agent/Worker 类型检查通过；一次性 fixture 覆盖输入、停止、Receipt 去重和重启 unknown | 未记录；GitHub 交付评论日期为 2026-10-12 | 检查 PID/PGID 与发信号之间存在 TOCTOU 窗口；PID/PGID 复用理论上可能影响无关进程。该风险已写入提交和 #11 评论；Shell 启用前必须专项复核 |

### 版本清单

| 项目 | 仓库证据 | 发布前需记录 |
| --- | --- | --- |
| 代码基准 | `caf10c36745ee2d03f24851e89541ea2d343d8d3` | 实际候选/发布 SHA 必须重新核对 |
| Agent / Worker package version | 两个 `package.json` 当前均为 `0.0.0`，没有语义版本发行号 | 以 Git SHA、Node 版本及 Worker Version ID 识别，不能把 `0.0.0` 当作线上版本 |
| Agent runtime dependencies | 当前 Agent package 无 Desktop Commander 或 MCP client runtime dependency；T01R #13 评论记录替换迁移 | 发布包/进程启动后仍需核对实际启动命令和依赖清单 |
| Node.js | 根 `engines` 为 `>=24 <25`；T06–T09 记录的验证版本为 `24.21.0` | 主机的实际 `node --version`、安装来源及受管服务实际使用的二进制路径 |
| Worker compatibility | `compatibility_date: 2026-10-12`、`nodejs_compat` | Cloudflare active deployment 中的版本、配置和 bindings |
| Wrangler | 锁定 `4.130.0` | 使用 frozen lockfile 的仓库版本；不在验收中临时升级 |
| 生产 Worker / Agent / Portal | GitHub 仅有历史 Worker IDs；当前生产版本没有经本轮 Cloudflare/Portal 查询确认 | 分别记录 active Worker Version ID、Agent SHA/runtime、Portal endpoint 与同步后的工具清单 |

历史 Worker Version ID 仅用于追溯；不能直接假定它们仍部署、可回滚或包含当前绑定。当前 `wrangler.jsonc` 的 `REMOTE_CONTROL_DEVICE` `service_id` 为全零占位值。

## 发布前核查与发布步骤（待授权）

执行任何真实步骤前，为该步骤取得 owner 对明确目标的授权。以下是执行清单，不是本轮已执行的操作。

1. 固定候选 Git SHA；确认工作树干净，使用 Node.js 24.x 和仓库锁文件安装依赖。运行 Agent、Worker 类型检查及完整测试，记录 Node、pnpm、SHA、命令、日期和结果。禁止在测试证据中混入真实凭证或真实文件。
2. 由授权操作者在 Cloudflare 核对 Worker 名称、active Version ID、MCP Access Secret 与 device Secret 的存在状态、Portal endpoint、VPC Service ID/目标和 Tunnel ID。值只在受控凭证界面处理；不要复制到终端参数、Git、Issue、截图或日志。Agent 从进程环境读取 device token；核对实际 service manager/secret 注入方式与配置文件 ACL。若使用环境文件，限制为 owner-only（例如 `0600`）；不要假定环境变量对同 UID 用户或 root 保密。
3. 核对 `REMOTE_CONTROL_DEVICE` 已替换占位 ID，并仍绑定单个预期 HTTP 服务。工具参数不能选择主机、端口、URL 或 PID。核实 Worker 到 Agent 的固定路径、Agent 只监听预期 loopback 地址、Tunnel 在同一可达网络命名空间；不得推断 `localhost` 跨 WSL/容器/网络命名空间可达。
4. 先验证失败关闭：缺失/错误 ingress Bearer、未允许 Origin、错误 device credential、Worker/VPC/Tunnel/Agent 离线；确认不会回退到公网路径、排队重试或自动唤醒主机。之后才可在另行授权下通过 Portal/ChatGPT 做无敏感数据只读调用。
5. 文件写入、凭证轮换、Portal Sync、真实 Shell 分开审批。Shell 前重看 Linux 实际账户权限与 T09 TOCTOU 风险；失败或 owner 未决定时不开放 Shell。
6. 部署后保存 Git SHA ↔ Worker Version ID ↔ Agent 运行版本映射，Portal 实际工具清单、日志/权限核查结果、授权范围及 owner 的发布决定。只要有一项必需门槛未通过，记录为“尚未通过发布验收”。

### VPC Service 适用条件（2026-10-12 官方文档核对）

- Workers VPC 当前仍标注为 Beta；Cloudflare 说明 beta 期间 API/功能可能变化。服务绑定提供到特定私有服务的路由，适合本项目固定到单个 Agent 的边界；不要改为能访问整张私网的 VPC Network。
- 当前官方 Tunnel 文档要求 `cloudflared` 2025.7.0 或更新版本，并要求 QUIC (`auto` 或 `quic`) 及允许出站 UDP 7844。真实主机当前版本、防火墙和隧道配置没有核查。
- HTTP VPC Service 的配置目标 host/port 决定实际路由；Worker `fetch()` URL 中的 host 影响 HTTP Host header，port 会被忽略。继续保持固定 Worker binding 和固定应用路由，不能让 MCP 参数拼接 URL。
- VPC Service 创建需 Connectivity Directory Admin；Worker 绑定既有 Service 需 Connectivity Directory Bind。部署操作者还须具有适用的 Worker deploy 权限。
- 若使用 HTTP，Tunnel 到 Agent 的最后一段是明文；若改 HTTPS，则要验证 origin TLS 证书/SNI 与 Service scheme/port 匹配，不能凭 Worker 到 Cloudflare 的链路加密推断 origin 段也加密。

官方依据：[VPC Services](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/)、[Tunnel](https://developers.cloudflare.com/workers-vpc/configuration/tunnel/)、[Workers VPC limits](https://developers.cloudflare.com/workers-vpc/platform/limits/)，核对日期 2026-10-12。

## 最小生命周期、断网、停用与回滚手册

### 正常启动与检查

- 原生 Agent 以已授权的现有非 root Linux 账户运行，设置 `REMOTE_CONTROL_DEVICE_TOKEN`、`REMOTE_CONTROL_AGENT_HOST=127.0.0.1` 和批准的端口（默认 9477）；不要使用 sudo/root。代码仓库只有 `start` 脚本，没有经核实的 systemd unit 或主机级监督器，故不得假定已有持久化服务配置。
- 在批准的监督方式下，从候选 SHA 启动 `pnpm --dir apps/remote-control-agent start`。启动后核实其只监听 loopback，并按该真实网络命名空间检查 Tunnel 到目标的连通性。
- 启动或恢复 `cloudflared` Tunnel 后，再核对 VPC Service；最后启动/部署 Worker 并通过 Portal 执行已批准的无害探测。睡眠、WSL 停止、Tunnel 或 Agent 断开时必须失败关闭；不得后台排队、自动重放或自动唤醒主机。
- 任何只读验证通过都不自动批准文件写入或 Shell；二者仍需独立操作目标授权。

### 停用 Remote Control 入口与服务

1. 先禁用 Portal 连接/客户端入口；该动作不撤销 Worker Secret，不能单独作为凭证吊销证明。
2. 若需要立即切断 Worker ingress，在单独获准后撤销/移除 Remote Control Worker 的 `MCP_ACCESS_TOKEN`，使缺配置路径 fail closed；确认远程调用不可用。不要触碰 IMA、Raindrop、Database 的 token。
3. 停止 Agent 受管服务/进程并等待关闭；如果进程身份无法确认，不向猜测出的 PID 或进程组发送信号。再停止专属 `cloudflared` Tunnel。删除 Cloudflare 资源或改变私网配置需要独立授权。
4. 保留操作回执供人工核对：默认位置为 `~/.local/state/mcp-workers/remote-control-agent/operation-receipts.json`，目录权限 `0700`、文件 `0600`。在 unresolved/unknown 操作已人工核对前不要清理回执。会话输出在内存中有界缓存；Agent 关闭或重启后不可依赖其仍在。

### 凭证轮换与撤销

Remote Control 使用专属 Worker ingress Secret `MCP_ACCESS_TOKEN` 和独立 Agent 凭证 `REMOTE_CONTROL_DEVICE_TOKEN`。它们必须彼此不同，也不能复用其他 MCP Workers 的 token 值。当前 Agent 只接受一个 device token，不提供双凭证无缝过渡，因此轮换需计划短暂中断。

Agent 通过 `process.env.REMOTE_CONTROL_DEVICE_TOKEN` 读取 device token。当前仓库没有提供 Agent service unit 或 secret-file 管理器；真实环境必须核查 token 注入源的 owner、文件权限和 service manager 可读范围。若以 environment file 注入，限制为 owner-only；同 UID 进程和 root 的可见性仍由实际 Linux/服务管理器配置决定。绝不将值写进仓库或复制到交付记录。

1. 在受控凭证管理器生成新值；不要在命令行参数、shell history、GitHub 评论、终端录屏或日志中展示值。
2. 如怀疑泄露，先在获准范围内禁用 Portal 入口或使 Worker ingress fail closed；再协调更新 Agent device token 与 Worker `REMOTE_CONTROL_DEVICE_TOKEN`，重启 Agent。验证旧凭证被拒绝、新凭证可用，失败时保持入口关闭并修复配置。
3. 独立轮换 Worker ingress token，并更新只服务 Remote Control 的 Portal 配置；验证旧 ingress token 被拒绝、新 token 能完成授权只读探测。该验证不得修改 IMA/Raindrop/Database token 或可用性。
4. 怀疑 Tunnel 凭证泄露时，单独核准 Tunnel 凭证轮换/撤销和 VPC Service 连通性恢复；不将 Tunnel token 与应用 device token 混用。
5. 留下凭证名称、轮换时间、旧值失效与新值验证结果，不记录值本身。紧急撤销优先让 Worker 入口 fail closed，并停止 Agent/Tunnel；恢复服务必须重新通过授权与健康核验。

### Worker 回滚与 Agent 回退

- 部署前必须记下已知良好的 Worker Version ID 和对应 Git SHA。获准回滚时，按 Cloudflare Dashboard Worker → Deployments 的目标版本执行 Rollback，或使用固定 Wrangler 版本的 `wrangler rollback`；回滚后核对 active Version ID、固定 VPC binding、失败关闭与已授权的只读路径。Cloudflare 回滚会创建新的 deployment；不会自动撤销 Secret、Portal 配置或 Agent 版本。
- Agent 回退到记录过的 Git SHA，以 Node.js 24.x 在同一已授权账户启动并核对 `REMOTE_CONTROL_DEVICE_TOKEN` 配置来源、loopback 监听和回执兼容性。先保留 receipt 文件；回退不证明既有 side effect 未执行，也不恢复旧 session。
- 若回滚版本和当前版本的 Secret/binding 不兼容，或 VPC Service / Tunnel 已变化，不要盲目回滚；先保持入口禁用并按当前 Cloudflare 限制处理。不要自动重放任何 `unknown` receipt 或 session 操作。

### Unknown 操作人工核对

- 用原 `operation_id` 查询 `get_operation_status`，保留 `unknown` 结果；仅在针对该目标获准后，用具体的只读观察核对目标文件/状态。没有观察到变化不能证明副作用未发生。对进程 session，Agent 重启后旧 session 不会恢复，不能对 stale session 发送输入或停止请求。
- 如果副作用仍无法证明，停止在原操作上，不要另发新 ID 重放同一意图；提交 owner 决定后再执行新的明确意图。回执过期或变成 `not_found` 也不能推断原操作未发生。

## 本地数据、日志和待核风险

| 数据/边界 | 当前实现或已知事实 | 发布前核查 |
| --- | --- | --- |
| Operation Receipt | 单文件本地 JSON；目录 `0700`、文件 `0600`；最多 1,000 条，终结态按创建时间保留最多 30 天；Agent 重启将 admitted/running 改为 unknown；过期只表示 `not_found`，不表示操作未发生 | 在目标文件系统核验 owner/mode、备份/同步行为和清理责任；检查是否会进入系统备份或云同步 |
| Managed Session 输出 | 有界内存缓存，每 session 最多 256 KiB，最多 10 个活动 session；Agent 重启不恢复 session，终结 session 按 30 分钟 TTL 清理 | 确认运行中主机的 core dump/swap/诊断采集策略；确认日志系统不另行捕获 Shell 输入/输出 |
| Agent diagnostics | 应用层仅允许固定事件名；不记录命令、参数、文件内容或凭证 | 核查 stdout/stderr 被哪个 service manager 收集、保留多久、谁可读；做合成敏感标记检索 |
| Cloudflare observability | `wrangler.jsonc` 启用 invocation logs、head sampling rate 1 | 真实部署前查看当前平台日志字段/保留/访问权限，确认不收集敏感请求正文；必要时获准调整配置 |
| Agent device credential | Agent 从 `REMOTE_CONTROL_DEVICE_TOKEN` 进程环境取值；仓库未定义 service unit 或 secret-file 保护 | 检查实际 service manager、注入源 ACL/owner、文件是否 `0600`、同 UID/root 的可读边界；不得读取或记录凭证值 |
| Linux 权限 | Agent 使用当前账户的真实权限，没有容器或路径 allowlist。T07 核查记录 Docker group/socket 风险、WSL Windows 文件访问等 | T07 对 WSL `ray` 的风险接受不是沙箱，也不扩展到其他主机/账户；发布时核实目标确为该环境/身份 |
| Stop signal | PID/PGID 检查和发信号之间非原子；复用时理论上可能误发给无关进程；action 的 `unknown` 不证明无副作用 | 在真实环境启用 Shell 前单独重审竞态窗口和可接受性；不因 T07 风险接受自动放行 |
| Portal/static Bearer | T02 曾证明早期只读 Portal/ChatGPT 路径 | 证明当前部署与当前 Portal capabilities；Sync capabilities 是单独授权的联调动作 |

## T10 真实验收记录模板

每项结果写入获准的 T10 发布记录，保留失败与未验证状态。密钥值、完整凭证、原始 Shell 输出和敏感文件内容不得进入记录。

| 项目 | 目标/版本 | 日期与操作者 | 结果/证据链接 | 状态 |
| --- | --- | --- | --- | --- |
| Worker active Version ID、Git SHA、固定 VPC binding |  |  |  | 未验收 |
| Agent SHA、Node.js 版本、Linux 用户/UID、监听地址 |  |  |  | 未验收 |
| Tunnel 状态、版本、QUIC/UDP 7844、防火墙与网络命名空间 |  |  |  | 未验收 |
| Portal endpoint、实际 tools/list、safe read-only 调用 |  |  |  | 未验收 |
| ingress token 旧值失效/新值可用，其他 Workers 不变 |  |  |  | 未验收 |
| device credential 撤销/轮换及旧值失效 |  |  |  | 未验收 |
| 错误凭证、Origin 拒绝、Agent/Tunnel 离线 fail closed |  |  |  | 未验收 |
| 日志、Receipt、session output 权限、保留和清理 |  |  |  | 未验收 |
| 文件写入专项批准及真实验证 |  |  |  | 未授权/未验收 |
| Shell 专项批准、TOCTOU 决定及真实验证 |  |  |  | 未授权/未验收 |
| Worker/Agent/Tunnel 停止、回滚及恢复结果 |  |  |  | 未验收 |
| Owner 发布决定及授权范围 |  |  |  | 未决定 |

## 参考

- [父规格 #2](https://github.com/lirtual/mcp-workers/issues/2)、[T01 #3](https://github.com/lirtual/mcp-workers/issues/3)、[T02 #4](https://github.com/lirtual/mcp-workers/issues/4)、[T03 #5](https://github.com/lirtual/mcp-workers/issues/5)、[T04 #6](https://github.com/lirtual/mcp-workers/issues/6)、[T05 #7](https://github.com/lirtual/mcp-workers/issues/7)、[T06 #8](https://github.com/lirtual/mcp-workers/issues/8)、[T07 #9](https://github.com/lirtual/mcp-workers/issues/9)、[T08 #10](https://github.com/lirtual/mcp-workers/issues/10)、[T09 #11](https://github.com/lirtual/mcp-workers/issues/11) 与 [T01R #13](https://github.com/lirtual/mcp-workers/issues/13)。
- Cloudflare 官方：[VPC Services](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/)、[Tunnel for Workers VPC](https://developers.cloudflare.com/workers-vpc/configuration/tunnel/)、[Workers VPC limits](https://developers.cloudflare.com/workers-vpc/platform/limits/)、[Worker rollback](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)。VPC 事实在 2026-10-12 核对；上线前应重新核对 beta 状态、角色、网络要求与回滚限制。
