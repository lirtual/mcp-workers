# Remote Control MCP — T10 离线发布验收材料

**状态：2026-10-13 只读链路、入口与设备凭证轮换、Agent/Tunnel 受控故障及人工恢复、回执只读核查和安全回滚方案审查已完成；Invocation Logs 已关闭。历史日志核销、旧凭据直接拒绝、回执过期删除实测、T07/T09 风险决定及 owner 最终发布决定仍未完成；无人值守自动恢复未验收且不属于已通过项。T10 整体验收保持 Open。下文保留证据边界。**
**历史离线核对基准：** `main` 提交 `caf10c36745ee2d03f24851e89541ea2d343d8d3`，日期 2026-10-12；线上只读验收基准见下文增量记录。
**Issue：** [T10 #12](https://github.com/lirtual/mcp-workers/issues/12)（保持 Open）；父规格 [#2](https://github.com/lirtual/mcp-workers/issues/2)（保持 Open）。

本文整理离线实现证据、分日期的真实环境核查、发布前检查、回滚和撤销步骤。每项结论按报告、只读 API、真实插件调用或代码证据注明边界；未验证项不得推定通过。T07 的账户风险接受也不等于 T09 进程停止竞态已获准。

## 2026-10-14 I4 取消 Worker 权限开关：受控发布前检查（待授权）

**代码目标：** `main@c74d7a9a8e557d3ec46115c8e28d3a45f7155392` 合入 [#40](https://github.com/lirtual/mcp-workers/pull/40)，两个 Worker 侧开关 `REMOTE_CONTROL_ENABLE_FILE_WRITES`、`REMOTE_CONTROL_ENABLE_SHELL` 不再决定工具是否列出或调用。[#41](https://github.com/lirtual/mcp-workers/pull/41) 修正手动发布的旧开关断言；发布前须先合入并验证最终 `main`。**此节是待执行的操作手册，不证明生产已发布、主机重新验收或恢复方案已演练。**

1. **记录基线：** Cloudflare 旧生产活动版本 `0d20de83-2033-40b5-a179-c608ddeb3890`（2026-10-14 只读核查为 100%）、固定 VPC Service 绑定名、独立 Portal/设备 Secret **名称**、Invocation Logs=false、Portal 当前工具数量 18；不读取 Secret 值。现有旧开关均为 `true`。新版本发布后这两个变量即使还存在也**不再具有熔断效果**；不得把其值改为 false 当作紧急制动。
2. **目标身份与链路：** 由操作者只读复核实际 Linux Agent 所在 WSL2/主机、当前运行用户/UID、Shell 路径、sudo/Docker socket/WSL 挂载访问边界、Tunnel/VPC 在线状态和 Agent 版本。先前已接受的 `ray` / UID 1000、pidfd/进程脱组残余风险仅适用于当时已核实的设备/身份；任何身份漂移先停止发布。#29 的历史 `run_command` 失败尚需真实插件回归，不能以已合并代码或 CI 代替。
3. **准备恢复：** 保留最后可信源提交、当前绑定/环境设置清单与有效 Secret 的**受控存放方式**，私下核对 GitHub Actions `REMOTE_CONTROL_VPC_SERVICE_ID` 与当前 VPC ID；仓库 `wrangler.jsonc` 仍使用全零占位符，必须走已有受控发布脚本的临时 VPC 配置路径。**不得直接回滚至未知 Secret/Invocation Logs 状态的历史 Cloudflare Version。** 紧急隔离选项是经授权切断 MCP Portal 入口或停止 Agent/Tunnel；代码恢复须从已审查的受限 Worker 源重新发布，并复核现行 Token、VPC、日志设置。恢复步骤仍未演练，不得宣称可自动回滚。
4. **独立发布授权：** 指定当前源 SHA、唯一目标 `remote-control-mcp-worker`、操作时段、维护影响及停止条件。仅在获准后从 `main` 执行已有 `ci.yml` 的 `workflow_dispatch`；不能用 PR/push 事件代替生产发布。等待 Application checks、真实活动 Version 与 VPC/Secret/日志只读回读均通过，且确认其他三个 Worker 未被部署。
5. **先无副作用验收：** Cloudflare MCP Portal 同步后，刷新真实 ChatGPT Remote Control 客户端，核实 `initialize`/18 个公开工具、`run_command` 命名、声明的危险性与参数契约；检查缺失/合成错误 Bearer 拒绝，**不要泄露或复用旧真实凭据**。针对指定已存在的非敏感只读 fixture 执行 `read_file`；Portal ready 本身不能证明 Agent 在线。
6. **单独授权的受控操作验收：** 仅当操作者再次批准**准确设备/用户、一次性测试路径、无害命令和 operation_id、退出/清理方式**，才允许通过真实 ChatGPT MCP 做一次性 fixture 写入和受限 Shell 输出/回执测试，并用全新意图 ID；结果未知先查原 ID 的回执，禁止盲目重放；验证 #29 的真实命令启动错误分类，且不触及其他真实主机数据或进程。
7. **止损与完成定义：** 若 Agent 身份漂移、Portal 工具描述未刷新、Auth 失败打开、VPC/日志/Secret 绑定异常、#29 无法完成安全调用、出现敏感日志或回执不明，则停止验收，**不得自动重试写入或 Shell**，按已批准的隔离/新恢复版本方案处置。只有实际 ChatGPT 端工具/安全/回执验收及回滚路径由负责人明确接受后，才可标记 I4 生产阶段完成。

**状态：** 目前只读 Cloudflare/Portal 检查和离线 CI 有证据，未重新访问真实 Agent；未获得此 I4 新版本的单独生产部署与真实操作测试授权。禁止为了“验证开关删除”而提前删除生产变量或执行 Command。

## 2026-10-13 回执生命周期只读核查与安全回滚审查

**范围：** 读取回执文件元数据和一条现存回执状态；Cloudflare 日志只使用 `dry=true` 聚合查询和字段名发现；检查 Worker 版本绑定元数据与仓库配置。未读历史日志正文或任何 Secret 值，未删除数据、生成测试回执、修改线上配置、轮换凭证或执行 Worker 回滚。

### 回执与会话

- 真实回执文件为 340 字节，模式 `0600`；目录模式 `0700`。只读统计显示 1 条 `completed` 的 `start_process` 回执，创建时间 `2026-10-12T10:07:42Z`；`get_operation_status` 返回 `completed`。操作 ID、参数摘要和结果摘要未在交付记录或对话中展示。
- Agent 实现对终态回执使用 30 天 TTL，在 Agent 打开存储、接纳操作或查询状态时惰性清理，不运行后台定时清理。启动时，`admitted` / `running` 会被改为 `unknown` 并清除关联 session ID；过期状态查询也会删除对应记录。
- 当前唯一回执未过期，因此此次只核实了现存状态和保留边界，没有实测过期删除。真实清理会改写回执文件；不伪造过期时间或创建/删除线上记录来声称通过。
- Managed Process sessions 仅保存在 Agent 内存，终态 session 30 分钟后惰性清理；每个 session 最多保留 256 KiB 输出，最多 10 个 session。Agent 重启后不恢复旧 session；受控重启期间的回执/会话未知状态按实现中的规则处理，不自动重放命令。

### Cloudflare 历史日志

- 官方 Workers Logs 文档（2026-10-12 更新）列明最大保留 7 天，Workers Free 为 3 天、Workers Paid 为 7 天。订阅列表 API 返回认证错误，因此账户实际套餐和适用保留周期未能确认。
- 只读 `dry=true` 元数据查询在最近 7 天范围内统计到 264 条该 Worker 的 `cf-worker-event` invocation 记录。分段查询显示，`2026-10-13T05:03Z` 之后计数为 0；`05:32Z` 之后计数仍为 0，同时有 15 条非 invocation 日志事件。字段名发现未返回包含 `authorization` 的字段名，但这不证明历史 invocation 记录已经删除，也不证明嵌套请求头不再可见。
- 先前审计发现的 2 条带 `authorization` 字段的记录没有再次读取。当前设置仍是 `invocation_logs=false`、应用日志启用且持久化开启；Worker Logs 查询中的记录数量不能证明那两条记录已过期或删除。
- Account Members API 当前列出 2 名账户级 `Super Administrator`。Cloudflare 官方 Worker 权限文档还定义了可查看 logs/traces 的 Worker 级 `Metadata Read-Only` 角色；本次只读 API 无法枚举该 Worker 的所有 scoped grants 或访问审计历史，故不能把可见范围收窄为仅这两名账户成员。
- 未发现当前配置的 Logpush、Tail Consumer 或 Observability 外送目标（既有只读核查）。这不能证明历史上从未外送，也不代替对第三方副本的审计。Workers Logs 的自然保留期是当前可支持的到期路径；没有证据表明可单独删除其历史 invocation 行。

### Worker 回滚评审

- 当前 `2cd50f42-7290-4a90-9cde-28474389980a` 为 100% active。Cloudflare Versions API 对 `2cd50f42`、`f9c88002` 和 `4161e117` 均只显示 `MCP_ACCESS_TOKEN` 与 `REMOTE_CONTROL_DEVICE_TOKEN` Secret 绑定名称，不返回值；所有版本都包含同一个 VPC Service `01a12f13-7963-7241-bc38-3efba612d17e`，并显示文件写入和 Shell 门控为 `false`。版本详情没有返回可核实的 `invocation_logs` 字段。
- 按版本创建时间和已记录的轮换顺序，`f9c88002` 早于设备凭证轮换，`4161e117` 早于入口凭证轮换；Secret 绑定值不可见，因此不能证明直接回滚不会恢复旧值。不能直接回滚至这两个版本。
- 当前仓库 `apps/remote-control-mcp-worker/wrangler.jsonc` 中 VPC Service ID 是全零占位符。直接用此配置部署并不能保留线上 VPC 绑定。
- **安全回退方案（仅审查，未执行）：** 紧急代码恢复时先保持 ChatGPT 入口 fail closed；不调用 Cloudflare 历史版本 Rollback。基于当前审过的源代码制作新的恢复版本，从受控 Secret 管理器重新注入当时仍有效的 ingress/device Secret，并显式绑定当前 VPC Service ID；确认 `invocation_logs=false`、应用日志策略、写入/Shell 门控后再发布。发布后 GET 核实 active Version、绑定和门控，并通过新凭证及固定只读 marker 做回归；错误凭证只能用合成值验收。Cloudflare 官方说明 Rollback 会立即为指定历史版本创建 deployment 并在已部署路由/域名上激活，因此任何直接 Rollback 仍须另行审批及逐项核验。
- 在当前已轮换的凭证与安全设置下，没有找到可直接从仓库部署的可回退包：本地配置 VPC ID 为占位值；安全恢复版本需先构建并审阅，不能把“方案已审查”表述成“回滚已演练通过”。

**本节判定：** 回执当前状态与实现保留规则已核查；安全回退流程已审查。回执过期删除未实测，历史认证头记录未核销，旧凭证未直接验证拒绝，自动恢复未验收。T10 整体仍未通过，T10 #12 与父规格 #2 继续 Open；不据本节作最终发布决定。

参考：[Cloudflare Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)、[Workers roles and permissions](https://developers.cloudflare.com/workers/authorization/workers/)、[Cloudflare Worker Rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)。

## 2026-10-13 只读版本发布门槛判定

本判定只针对当前固定工具面、文件写入/Shell 均关闭的只读版本。它是剩余证据的风险分类，不是 owner 的最终发布批准，也不把 T10 的完整验收标准改写成只读版本标准。

| 剩余项 | 对受限只读发布的判定 | 依据与关闭条件 |
| --- | --- | --- |
| 已知历史 Invocation Logs 中的认证头记录 | **隐私发布阻断，须先核销或由 owner 明确接受残余风险** | 已知存在 2 条 `authorization` 字段记录；关闭后续采集并轮换入口/设备凭证降低了旧值继续使用风险，但没有证明记录已过期、删除或访问范围受限。安全路径是等到适用保留期后用元数据重新核验；账户实际套餐未确认，不能直接假定 3 天或 7 天到期。若仍未能核销，应由 owner 明确接受历史日志可能保留认证信息及当前访问边界不完整的风险，不能记录成“日志已清除”。 |
| T07 普通 Linux 用户权限边界 | **目标身份/主机确认与明确风险决定是发布阻断** | 已有 T07 对特定 WSL2 `ray` 用户的风险接受记录，但该账户不是隔离环境；只读 `read_file` 可访问该用户有权读取的文件。发布决定必须确认当前 Agent 仍运行在已核查的目标身份/主机，并明确接受这一读取边界。该接受不扩展到其他设备、身份或 Shell。 |
| 旧入口/设备凭证直接拒绝证据 | **不是当前只读调用的操作阻断；作为凭证撤销证明仍未完成** | 新 Secret 配置下真实只读调用通过，设备认证轮换也有报告；旧凭证没有 Worker 层 401 证据。不得恢复、导出或猜测旧凭证。若未来需要更强撤销证据，只能使用此前安全记录或服务端撤销/轮换证据，不以重放旧密钥为条件。 |
| 其他 MCP Workers 未受入口凭证轮换影响 | **完整 T10 验收阻断；当前只读功能已通但影响范围证据未闭合** | T10 验收标准要求确认 Remote Control 专属入口轮换不改变其他 Worker 的 token 与可用性。当前证据没有提供对照核验。可以用只读配置/健康信息完成，不需重启或改动其他 Worker。 |
| 无人值守 Agent/Tunnel 自动恢复 | **不阻断受限只读发布，前提是接受人工恢复和可用性边界** | 已通过的只是受控故障下失败关闭及人工恢复；首轮 Tunnel 控制器未自动恢复。若产品承诺无人值守/主机重启自愈，则在相应承诺发布前构成阻断；本次不得描述为自动恢复通过。 |
| 回执过期清理实测、生产 Worker 回滚演练 | **不是本只读版本的直接阻断项；是完整生命周期/变更恢复验收缺口** | 当前工具面关闭所有产生写回执的能力，现存唯一回执未到期；不应制造线上记录或改时间补证。历史 Worker 回滚存在恢复旧 Secret/日志设置的风险，且仓库 VPC ID 是占位值；不得直接回滚。若要宣称具备生产回滚能力，先构建并审阅带当前有效 Secret 与真实 VPC 绑定的新恢复版本，再另行授权演练。 |
| T09 PID/PGID 停止竞态 | **不阻断当前只读工具面；Shell 发布的硬阻断** | 风险针对进程停止工具；Shell 门控仍为 `false`。启用 Shell 前须专项裁决，T07 接受不能覆盖此风险。 |

**发布判断：** 线上只读链路与当前门控已有证据，故没有理由为了关闭 T10 再做生产故障或回滚演练。但“只读功能运行成功”不等于“可不经决定地对外发布”：历史认证头风险、当前主机/身份是否落在 T07 接受范围，以及其他 Worker 影响范围核验，仍是正式发布记录的门槛。取得这些只读证据并由 owner 作出明确的受限只读发布决定后，可将无人值守恢复、回执过期删除和回滚演练保留为 T10 生命周期剩余项；在此之前 T10 #12 与父规格 #2 均保持 Open。文件修改和 Shell 仍关闭。

## 2026-10-13 设备轮换与故障恢复增量验收

以下是设备侧执行报告及本次独立只读复核，不记录任何凭据值；故障期间的行为以执行报告为证，不冒充本轮重新复现。

- 设备侧报告：已同步更新 Agent 与 Worker 的设备认证配置；Agent 原 PID 495681 停止后 PID 583558 启动，新配置下健康检查 200、合成错误认证检查 401。旧凭据没有直接用于测试。
- 后续受控故障演练：分别停止 Agent 和 Tunnel，ChatGPT 只读调用均返回“设备不可用”；各自恢复后，均重新返回准确的 `remote-control-t02-marker`。
- Agent 故障恢复：SIGTERM 停止后恢复，新 Agent PID `602428`。本次使用真实 Remote Control `read_file(/proc/self/status)` 独立确认 PID 为 602428、UID 为 1000。
- Tunnel 故障恢复：Agent 本机保持在线；首次控制器失去输入通道，**没有自动恢复**，操作方使用既有 token-file 配置手动恢复；随后第二轮完整停止、故障探测、恢复成功，临时控制脚本已清理。操作方报告 Tunnel PID `603541`，只发现一个 cloudflared 进程；本轮未独立读取其 PID。
- Cloudflare 独立复核：Worker `2cd50f42-7290-4a90-9cde-28474389980a` 100% active，Invocation Logs=false，应用日志及持久化开启，VPC Service 绑定保持，文件写入和 Shell 门控均为 false；新 Tunnel healthy、2 条连接。
- 恢复后再次由 ChatGPT 插件真实读取无害文件，结果精确匹配 `remote-control-t02-marker`。

**判定：受控的 Agent/Tunnel 离线失败关闭及人工恢复通过；无人值守自动恢复、主机重启后的自启动没有通过验收，也未曾承诺。** 当前只读功能仍可用，未执行回滚。

剩余 T10 项包括：历史 Invocation Logs 记录的实际保留/删除边界、轮换前版本的安全回滚、旧凭据直接失效证明、回执生命周期实测，以及 owner 最终验收决策。历史 Worker `f9c88002-1e8f-46a1-b25c-14d936dd09d4` 已是设备配置轮换前版本，不能未经评审直接回滚。T10 #12 与父规格 #2 保持 Open。

## 2026-10-13 历史日志访问边界与安全回滚只读复核

**复核范围：只读，不读取历史日志正文或任何 Secret、不删除数据、不轮换 device token、不执行回滚。** 本节根据本轮只读审计报告登记，不把未返回的控制面信息推断为已验证通过。

| 主题 | 审计观察 | T10 结论 |
| --- | --- | --- |
| Worker 账号套餐/实际保留期 | Cloudflare 订阅查询出现认证错误，当前套餐未确认。官方 Workers Logs 文档写明 Workers Free 保留 3 天、Paid 保留 7 天，Workers Logs 最长 7 天 | **实际保留期未知**；2026-10-13 带 `authorization` 字段的旧日志不能认为已经到期或删除 |
| 访问主体 | 账户当前列出 **2 名 Super Administrator**；未在本轮记录成员身份或凭证 | 只确认可见账户级高权限成员，不代表历史日志访问权仅限两人、也未验证审计访问历史 |
| 日志外送 | Worker 无 Logpush、Tail Consumer 或 Observability 外送 destination | 当前配置层面未发现这些外送路径；不能证明过去从未外送 |
| 账户级 Log Explorer | 数据集列表为空 | **不等于** Workers Logs 中历史记录不存在，且 Log Explorer dataset 删除不等同 Workers Logs 单条日志删除 |
| 历史日志删除 | 当前工具与官方材料未提供 Workers Logs 单条历史记录可用删除证据 | 不执行/不推断可以删除；保留为待自然到期或官方支持方案进一步核对的风险 |
| 当前活动 Worker | `2cd50f42-7290-4a90-9cde-28474389980a` 100% active（Cloudflare Deployments API 复核） | 当前线上入口与设备凭证版本有效，Invocation Logs 保持关闭 |
| 历史 Worker 回滚 | 轮换前版本 `4161e117-4f04-48db-aad6-6daf68b17981` 的版本元数据仍有 `MCP_ACCESS_TOKEN` Secret 绑定；版本 API 不返回 Secret 明文 | **存在可能恢复旧入口凭证的回滚风险**；旧绑定存在不构成“回滚一定恢复旧值”的证明 |
| 回滚日志开关 | 历史版本元数据不足以说明回滚会否改变 `invocation_logs` | **未知**，任何回滚必须事先审批并在回滚后复核日志设置；不能把历史版本当成天然安全的恢复点 |

### 后续操作门槛

1. **历史日志风险保留为未核销**，禁止声称既有含 `authorization` 字段的 2026-10-13 日志已经被删除。需要时仅查询记录数量/元数据、套餐/保留期及平台访问面，不能再次读取原始敏感头内容；账户权限问题可另外查官方支持。
2. **回滚实行单独审批**：任何回滚前记录候选 Version ID、Secret 继承/绑定策略、VPC Service ID、`invocation_logs`、`REMOTE_CONTROL_ENABLE_FILE_WRITES`、`REMOTE_CONTROL_ENABLE_SHELL` 与恢复方案；不能直接回滚到凭证轮换前版本。轮换本身的旧值直接拒绝仍未完成实测。
3. **设备端凭证未获准轮换**：`REMOTE_CONTROL_DEVICE_TOKEN` 未改动。若单独决定轮换，须先确认 Linux 设备上 Token 的真实注入来源、目标文件/服务管理方式，并分别授权设备侧配置写入与受控 Agent 重启；同时同步 Worker 端 Secret，设计一致性和中断恢复验证。**当前 ChatGPT Remote Control 插件只读，不能通过它完成设备端写入/重启；不能以开启面向 ChatGPT 的 Shell/文件修改门控来绕过这个审批。**
4. 本轮未开展额外的日志正文审计、历史记录删除、设备凭证轮换、服务重启或回滚。T10 #12、父规格 #2 保持 Open，文件修改及 Shell 门控继续为 `false`。

**参考：** [Cloudflare Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)、[Workers Pricing](https://developers.cloudflare.com/workers/platform/pricing/)、[Log Explorer 数据集管理](https://developers.cloudflare.com/log-explorer/manage-datasets/)、[Worker 回滚](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)。

## 2026-10-13 专属入口凭证轮换验收增量

**结论：Remote Control ingress 凭证已更换，新值调用成功；未直接证明旧值触达 Worker 后被拒绝。** 此状态不等价于 T10 全部认证安全验收通过。

| 核查点 | 结果 | 证据等级 |
| --- | --- | --- |
| Cloudflare ingress token 更新 | 操作者报告仅 `remote-control-mcp-worker` 的 `MCP_ACCESS_TOKEN` 已以新随机值替换，Cloudflare 写接口 HTTP 200 | **执行报告**；Cloudflare GET 不返回 Secret 的旧值/新值 |
| Portal / One-MCP 同步 | 操作者报告对应 Bearer 更新 HTTP 200，capability sync HTTP 200 | **执行报告**；后续真实 ChatGPT 读取成功提供链路佐证，不替代管理接口回执 |
| 新配置部署 | Worker Version ID `f9c88002-1e8f-46a1-b25c-14d936dd09d4`，Cloudflare Deployments API 复核为 **100% active**；2026-10-13T05:02:50Z 创建部署记录 | **Cloudflare 独立只读核实** |
| 安全配置保留 | `observability.logs.invocation_logs=false`、应用日志保持启用、VPC Service 绑定数量仍为 1、`REMOTE_CONTROL_ENABLE_FILE_WRITES=false`、`REMOTE_CONTROL_ENABLE_SHELL=false` | **Cloudflare Script/Version Settings 独立只读核实** |
| 当前 ChatGPT 只读回归 | ChatGPT 真实插件 `read_file` 再次读取 `/tmp/remote-control-t02-fixture/marker.txt`，精确返回 `remote-control-t02-marker` | **本次真实 MCP 调用** |
| 旧 token 直接拒绝 | **未执行、未通过**。不保存也不恢复旧值；现有报告的伪造 token 直连请求在 Cloudflare 边缘收到 HTTP 403，无法证明到达 Worker、无法将其记为 Worker 401 | **证据缺口** |
| 其他 MCP Workers | 操作者确认没有修改其他 Worker 的凭证 | **操作范围报告**；没有独立复跑其他 Worker 的可用性 |
| Device 凭证 | `REMOTE_CONTROL_DEVICE_TOKEN` 未轮换 | **明确未实施** |

### 上线安全边界及剩余任务

- 旧值不是当前配置中预期的 ingress token，但**不等于旧值失效已由真实请求直接证实**；GitHub、Cloudflare、Portal 日志均不得记录/导出完整旧值或新值。
- 历史 Invocation 日志若包含此前认证请求头，仍需基于实际保留与访问边界处理；新的 ingress token 降低了继续使用旧 Secret 的风险，但**不会清除旧日志**。
- **回滚风险门槛：** Cloudflare Worker 回滚会使指定历史版本成为当前部署。回滚任何凭证轮换前版本前，必须核对待恢复版本的 Secret 绑定、只读门控和 Invocation Logs 配置，避免恢复已废弃的凭证或之前的危险日志设置。未授权或未验证时不执行旧版本回滚。[Cloudflare Rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)。
- 尚需单独授权并执行：旧凭证失效的可行独立证明方案（如存在合法保存的旧值且可通过不受 Edge 403 混淆的路径完成；不得重新获取或输出旧凭证）、其他 Workers 不中断证据、Device 凭证轮换/撤销、日志与回执的剩余实测、Agent/Tunnel 生命周期和回滚、最终 owner 决定。
- T07 不代表 Shell 批准；T09 PID/PGID TOCTOU 尚未裁决；文件修改与 Shell 继续保持关闭。**T10 #12 与父规格 #2 继续 Open**。

## 2026-10-13 Invocation Logs 止血执行记录（已获授权）

**处置已完成：** 仅对 Cloudflare `remote-control-mcp-worker` 关闭平台自动 Invocation Logs，保留 Worker Observability 与应用事件日志。此项是**未来日志止血**，不是历史日志的删除/完整凭证风险结案。

| 核查项 | 结果 | 验证方式 |
| --- | --- | --- |
| 线上设置变更 | `observability.logs.invocation_logs: true → false` | Cloudflare `PATCH /accounts/{account_id}/workers/scripts/remote-control-mcp-worker/script-settings` 返回 HTTP 200；随后单独 GET 复核 |
| 应用日志 | `observability.enabled=true`、`logs.enabled=true`、`logs.persist=true`、采样率 `1`，保持不变 | Cloudflare Script Settings 与 Version Settings 独立读取 |
| Worker 运行版本 | `4161e117-4f04-48db-aad6-6daf68b17981`，仍占 100% | Worker Deployments API；本轮未重新上传/部署代码 |
| 私有绑定与权限门控 | VPC Service 绑定仍为 1 个；`REMOTE_CONTROL_ENABLE_FILE_WRITES=false`、`REMOTE_CONTROL_ENABLE_SHELL=false` | Worker Version Settings API，只读取绑定类别和门控值，未读取 Secret |
| 真实只读回归 | 通过 ChatGPT 刷新后的 `remote-control` 插件再次读取 `/tmp/remote-control-t02-fixture/marker.txt`，响应完全等于 `remote-control-t02-marker` | 当前 ChatGPT MCP 工具调用；无文件修改或 Shell |
| 部署配置持久化 | `apps/remote-control-mcp-worker/wrangler.jsonc` 唯一变更为 `invocation_logs: false` | GitHub 提交 [`e54c191`](https://github.com/lirtual/mcp-workers/commit/e54c191d8b646c5f5b9bf2028bb3b1f7ba67952e) |

**仍未核销的风险：**

- 变更不会自动删除已生成的 Invocation 日志；历史记录可见范围、真实保留期限及是否需要单独撤销仍未知。本轮没有读取旧 `authorization` 值、创建新 Observability 查询或清除查询记录。
- **Remote Control 专属 ingress token** 尚未轮换、旧值失效尚未验证；device credential 如需轮换也应单独批准。不能由于日志采集已关闭就假定旧 token 安全。
- 实际 Worker 应用日志仍未完成独立内容核查；代码白名单不能单独证明平台上所有其他日志或痕迹没有敏感字段。
- Agent/Tunnel 的重启恢复、生产回滚、receipt 生命周期实测，以及 owner 最终发布决定仍待 T10 收尾。

**判定：** “Invocation Logs 继续产生敏感元数据”的当前配置缺陷已止血；T10 整体安全/发布验收仍是**未通过**。Issue #12 和父规格 #2 必须保持 Open；只读功能继续可用，写入与 Shell 继续关闭。

## 2026-10-13 历史风险发现：Invocation Logs 与认证头（处置前快照）

**T10 日志/隐私验收：未通过（blocker）。** 仅代表发现潜在凭证持久化暴露路径；不代表已证明第三方获取或滥用凭证。此前“Worker 级和 ChatGPT 只读功能验收通过”仍有效，但**不能代替完整的安全发布验收**。

### 证据分层（不记录任何凭证值）

- 本轮授权只读核查报告：查询到的 Worker Invocation 记录中有 **2 条包含 `authorization` 字段**；仅在内存中进行了一次非空布尔判断，未显示、复制、提交该字段内容。这里不对字段值作进一步断言。
- 本轮再由 Cloudflare Worker Settings API **只读复核**：`observability.enabled=true`、`head_sampling_rate=1`、`observability.logs.enabled=true`、`invocation_logs=true`、`persist=true`。`logpush=false`，`tail_consumers=[]`；按本轮核查报告，未发现 Observability 外送 destination。**“未发现外送”并不等于凭证安全或平台无可访问记录。**
- `apps/remote-control-mcp-worker/wrangler.jsonc` 当前同样设置 `observability.logs.invocation_logs=true`，应用源码 `console.log` 的事件白名单**不控制平台自动 Invocation 日志**。本次未核对 Worker 应用日志实际内容，因此此前的源码白名单只能视为实现检查。
- Cloudflare 官方 [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) 文档确认 Invocation Logs 自动包含请求、响应与关联元数据，可独立通过 `observability.logs.invocation_logs=false` 关闭。官方列出 Workers Logs 最长保留 7 天，Workers Free 3 天、Workers Paid 7 天；**账户当前计划、此账户实际保留时间和既有记录清理/撤销能力均未核实**。
- 本地回执目录权限 `0700`、文件 `0600`、大小 340 字节，文件修改时间报告为 `2026-10-12T10:08:13Z`。代码中终态回执在启动、操作或状态查询时惰性清理，**非定时任务**；没有读取正文、创建记录或实测历史清理。
- Cloudflare Observability 查询的首次调用因未设置 `dry:true` 而生成一条查询运行记录；后续查询设置 `dry:true`。没有发现同名保存查询，未执行日志或查询记录删除，不能把该运行记录当作已清理。

### 风险处置门槛与独立授权

1. **优先阻止今后的敏感 Invocation 日志产生**：在明确授权后评审并部署 `observability.logs.invocation_logs=false`（保留受控的应用事件日志），考虑 Wrangler 配置与线上配置一致性、部署对绑定/版本的影响。**本轮没有修改线上或仓库配置**。单纯下调 `head_sampling_rate` 不能当作敏感头清洗方案。
2. 变更完成后，使用**不包含真实密钥值**的元数据查询核对日志设置；如需证明没有新敏感字段，仅在另行许可下使用合成/非敏感探针，不能为了取证再次读取旧的真实认证头。
3. **历史已持久化的日志**不能由改配置自动证明被删除；需单独评估现有记录可见范围、保留/过期情况及账号访问权限。不要猜测或执行未获授权的日志删除。
4. 处置日志风险后，**单独授权轮换 Remote Control 专属 ingress token 并验证旧值失效、其他 MCP Workers 不受影响**；device token 的撤销/轮换按独立范围决定。任何完整凭证值不得进入 GitHub、聊天、命令行参数、日志或验收截图。
5. 维持 `REMOTE_CONTROL_ENABLE_FILE_WRITES=false` 和 `REMOTE_CONTROL_ENABLE_SHELL=false`，且 T09 PID/PGID TOCTOU 仍未裁决。Owner 重新确认隐私与发布决定前，**T10 #12 / 父规格 #2 保持 Open**。

**本轮授权边界：** 仅核查配置与书面登记；不触发 Worker 重新部署、Cloudflare Observability 更改、密钥轮换/撤销、Portal Sync、Agent/Tunnel 操作或 Shell。

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
