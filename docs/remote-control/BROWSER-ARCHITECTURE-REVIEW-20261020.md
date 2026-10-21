# Remote Control · 浏览器架构审查归档

**当前实施约束：**[BROWSER-AUTOMATION-SPEC.md](./BROWSER-AUTOMATION-SPEC.md) · [Issue #152](https://github.com/lirtual/mcp-workers/issues/152)

本文件曾记录多轮备选架构、H1–H24 交接设计、PoC 与隔离验收。最终方案已收敛，不再用旧时间线充当实现规范；原始内容保存在 [Draft PR #117 的 Git 历史](https://github.com/lirtual/mcp-workers/pull/117) 中。

## 仍有效的审查结论

- 复用已有 Portal、Remote Control Worker/DO、签名 WSS、Windows Agent、Agent SQLite 操作回执及单一 Playwright backend；不增第二套服务。
- 浏览器是 Agent 管理的独立 Chrome/Edge Profile 中的**整个 BrowserContext**，支持多标签页；不是个人日常浏览器 Profile，也不是远程桌面。
- 真实 Windows 有界面 Chrome/Edge 的隔离验证曾通过；完整 MCP→DO→WSS→Windows Agent 产品链路、全部交互工具和生产安装包仍需按主规格验收。
- 个人可信 Windows 场景接受的 localhost/LAN 重定向访问风险 **不构成 SSRF 隔离通过**；具有高影响的网站动作仍需要独立可验证授权，缺失时拒绝。
- RCA 已有 DO WebSocket Hibernation 和低频鉴权；浏览器常驻不应引入额外 Cloudflare 长驻任务或周期 RPC。
- Agent 操作锁只保护 Agent 并发，不阻止人工同时操作；异常结果不自动重放，Profile 冲突不强行接管。

**非当前方案：**显式 Agent/Human 控制权交接、人工活动采集、30 分钟空闲超时、24 小时会话寿命、第二套浏览器服务及强制固定工具数量。若需了解当时的测试步骤/讨论依据，查阅历史提交，不再复制到当前规范。
