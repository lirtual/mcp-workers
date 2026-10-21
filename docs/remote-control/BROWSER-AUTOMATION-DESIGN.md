# Remote Control 浏览器设计说明

**当前唯一有效设计：**[BROWSER-AUTOMATION-SPEC.md](./BROWSER-AUTOMATION-SPEC.md) · [Issue #152](https://github.com/lirtual/mcp-workers/issues/152)

本文件不维护第二套设计树。实施、评审、验收均直接使用主规格。

最终方向：现有 Windows RCA Agent 内的 Playwright 管理一个 Agent 专属、可见的 Chrome/Edge BrowserContext；可控制其中多个明确选择的标签页。浏览器与 RCA WSS/DO 生命周期独立；Agent 按需执行有界 MCP 操作，人可直接使用浏览器。无人工/Agent 交接状态机、无浏览器会话超时、无新增服务/数据库。工具优先满足必要网页操作，再依真实用例扩展。

**历史决策：**早期 Q1–Q52、H1–H24 的讨论、分叉设计和对 ego-lite 等项目的比较，见此文件在 [设计 Draft PR #117](https://github.com/lirtual/mcp-workers/pull/117) 中的 Git 提交历史。旧决策不再是实施要求。

**发布状态：**主规格确认不等于代码完成或生产启用。继续使用现有 Agent Draft #20、Worker Draft #143，并保持独立验收及发布授权。
