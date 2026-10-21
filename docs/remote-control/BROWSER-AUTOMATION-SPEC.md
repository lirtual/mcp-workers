# Remote Control · Windows 浏览器自动化最终规格

> **当前唯一实施依据｜2026-10-22｜Issue [#152](https://github.com/lirtual/mcp-workers/issues/152)**
>
> 面向**个人已配对的 Windows 设备**。复用现有 Remote Control MCP/Agent；不新建浏览器服务、DO、数据库、Task Space 或授权门户。文档描述产品目标，不代表所有工具已上线，也不授权合并、升级或生产启用。

## 1. 目标与边界

通过现有 **ChatGPT → MCP Portal → Remote Control Worker/DO → 签名 WSS → Windows Agent → Playwright** 按需操作由 Agent 启动的浏览器。

- **管理整个自动化浏览器上下文（BrowserContext）**，而不是仅管理一个固定 Page。可列举、显式选择、新建、关闭多个标签页，包括用户手动打开或网页弹出的标签页。一个独立 BrowserContext 可以拥有多个 Page；无第二个多标签页服务。
- 仅管理 **Agent 专属、持久化的 Chrome/Edge 自动化 Profile**，不连接/修改用户日常浏览器 Profile，不控制整个 Windows 桌面。每个已配对设备最多一个活动自动化浏览器会话；Chrome 与 Edge 的 Profile 分开保存。
- 新建浏览器时，读取当前 Windows 用户 HTTP/HTTPS 的系统默认关联，二者必须一致且为已安装可启动的 Chrome 或 Edge；有界面运行，没有隐式 headless 回退。用户随后修改默认浏览器不切换现有会话。
- **人机共享可见浏览器，AI 按需调用 MCP**。没有 Agent/Human 控制权状态、handoff/resume、人工活动监听、空闲超时或会话最大寿命。用户可在 Agent 调用之间手动登录、浏览和调整页面；**不保证**鼠标键盘与 AI 的物理互斥，也不承诺人工操作期间 AI 完全看不到页面。
- 独立的本地浏览器会话持续存在，直到用户手动关窗、显式 `browser_close`、进程/Agent 退出或既有设备撤销清理。**MCP 单次调用结束不关闭浏览器**；Profile 与有效 SQLite 操作回执按原约定保留。
- **RCA 的既有 WSS、DO WebSocket Hibernation、心跳、授权检查和重连逻辑保持不变**。浏览器开启不创建第二条连接、持续 RPC、Cloudflare alarm 或后台轮询。现有定期鉴权和真实 MCP 调用仍可能产生 Cloudflare 使用量；本地浏览器空闲本身不会持续唤醒 DO。

## 2. 操作模型

**会话：**`browser_start` 如果发现本 Agent 已管理且健康的活动会话，就返回现有 Session ID 与浏览器信息，不再新开窗口；否则创建新会话。状态/读取工具不隐式启动。关闭后下次需显式启动。

**标签页：**同一 BrowserContext 中各 Page 使用会话内稳定 `tab_id`，跨导航保持、关闭即失效。维护一个*明确选定*的目标标签页；在只有一个可用目标时可默认使用。存在多个可用页且没有明确目标时，返回列表供选择，而不是猜测“最新”“最前台”或由 URL/标题判断身份。允许显式选择人工新建的标签页；选择时可 `bringToFront()`。不可因原目标关闭而默默选择其他页；弹出窗口按相同规则处理。页面关闭与 BrowserContext 关闭事件应清除对应状态。

**执行：**每次 AI 浏览器操作都是有界 MCP 请求，复用现有 BrowserOperationGateway、Agent 操作锁和 SQLite Operation ID/Receipt。读与写操作均受同一 Agent 浏览器操作串行边界约束；远端返回 `running` 不等于底层动作结束，锁保持到实际动作结算。网络超时或结果 Unknown 不自动重放。页面变化或人工介入后重新读取/定位；目标模糊、已关闭或版本过旧就拒绝猜测。Playwright 的 locator 与自动等待能力优先于手写元素注册表/等待调度器。

**异常：**临时 WSS 断线不关闭仍由 Agent 管理的本地浏览器，重连不自动重放动作。Agent 重启后不盲目接管孤立浏览器进程或清理未知 Profile 锁；冲突则明确报错。Windows 锁屏/不可用时新页面交互保守失败，不转 headless；恢复可用后刷新页面观察。用户主动关闭窗口不自动重开。设备撤销沿用现有清理与不确定结果约定。

## 3. 最小浏览器工具集

工具是**面向操作的原子能力**，不是必须凑够特定数量。复用 Playwright 已有能力，只有真实任务不能覆盖时才增补工具。

| 能力 | 对外工具 / 方向 | 范围 |
|---|---|---|
| 会话启动/复用 | `browser_start` | 创建或复用当前 Agent 会话 |
| 会话状态 | `browser_status` | 是否运行、浏览器家族、会话和目标身份 |
| 导航 | `browser_navigate` | 指定目标标签页的受限 HTTP(S) 导航 |
| 页面观察 | `browser_snapshot` | 有界语义快照，按需聚焦查找；不强制另增 `browser_find` |
| 关闭会话 | `browser_close` | 关闭 Agent 会话，保留 Profile |
| 点击 | `browser_click` | 唯一且新鲜的语义目标 |
| 输入 | `browser_fill` | 输入框、文本域；不得把输入内容写入日志/回执 |
| 按键 | `browser_press_key` | 有界、明确的常用键盘操作 |
| 选择 | `browser_select_option` | 原生下拉列表 |
| 多标签页 | `browser_tabs` | `list/select/new/close`；列表只读，其他动作沿用 Operation ID |

**按真实需求扩展：**可优先使用聚焦 Snapshot 与 Playwright locator 自动等待；如果实际网站需要，才增加显式 `browser_scroll`、`browser_wait_for`、截图、悬停、浏览历史、弹窗处理、受控上传/下载。截图需先验证图片传输和尺寸；上传/下载必须复用既有 Agent 文件权限。不要为工具计数或 API 对称性增加冗余包装。

所有效果性工具（含标签页创建/选择/关闭，视具体动作）保持明确目标与 Operation ID；`browser_tabs(list)`、状态和快照等读取无需假装产生外部效果。统一工具结果清晰区分执行完成、失败、结果未知；**浏览器调用完成不证明网站业务事务已完成**。

## 4. 安全与已接受的取舍

- 页面文本、ARIA Snapshot 与截图均是不可信内容，**不能作为设备授权或高影响动作批准**。
- 浏览器操作可能产生不可逆的网站效果：普通 MCP 权限、用户登录状态、工具注解或对话“同意”本身，不等于经过现有可信链路验证的**单次、绑定操作及目标的授权**。缺乏可验证批准机制时，付款、发送、删除等高影响/不明确动作不得自动执行，交由用户手动完成。
- 个人配对 Windows 的 **Goal A** 已接受网页、重定向、DNS、子资源可能访问主机 localhost/LAN 的残余风险；**不得称为 SSRF 隔离**，也不代表授予内部网络管理权限。保留现有初始 URL 检查与设备权限约束。
- 人与 AI 物理操作可能重叠；Agent 操作锁只能防止 **多个 Agent 动作**互相争用，不封锁人工鼠标键盘。操作前需重新确认当前目标，不能承诺人工私密模式。
- 不对外提供任意 JS、CDP、Playwright 脚本、Shell、个人浏览器 Profile 读取或通用桌面控制。

## 5. 验收与完成条件

1. **会话/多页：**真实 Windows 默认 Chrome、Edge 有界面启动验证；`browser_start` 复用；同一浏览器列举/选择/新建/关闭多个 Page，人工新建的标签页可明确选中；原始目标已关闭不自动替换；显式关闭保留 Profile。
2. **常用任务：**使用受控网页完成浏览、搜索、点击分页、表单填写、键盘提交、下拉选择，并能在人工手动修改页面后再观察与继续；长页面不因固定输出截断而完全不可用。若自动等待不足，再增加有证据的工具，不预设完整 Playwright API。
3. **一致性/权限：**重复/并发操作、提前 `running`、Unknown 不重放、陈旧引用/错误 Tab ID、人工关窗、Agent 中断与 Profile 冲突、锁屏、断线/恢复、撤销、敏感数据日志与高影响动作拒绝均有确定结果。
4. **RCA 不回归：**真实 MCP → Worker/DO → WSS → Windows Agent → Playwright 的签名链路通过；闲置浏览器不产生额外 WSS 心跳或持续 Cloudflare Worker/DO 轮询；保持现有 DO Hibernation 与周期鉴权行为。
5. **发布门禁：**区分单测/类型检查、真实 Windows 验证、端到端集成、安装包与生产启用。现有 [Agent Draft #20](https://github.com/lirtual/remote-control-agent/pull/20) 与 [Worker Draft #143](https://github.com/lirtual/mcp-workers/pull/143) 增量实现；**未经单独批准不合并、不部署、不启用生产浏览器工具**。

## 6. 非目标

不建立 ego-lite Task Space、人工/Agent 交接状态机、定时会话回收、另一套浏览器服务或数据库、自动识别人工前台标签页、多浏览器实例池、系统级输入钩子、网页完全网络隔离、自动重放未知效果或全平台首发。

**历史：**此前 Grill With Docs 的 Q1–Q52、H1–H24、早期 PoC 和被替代的设计保存在本 Draft PR 的 Git 历史与 Issue 讨论中，**不是当前实施约束**；此文件只说明最终有效方案。
