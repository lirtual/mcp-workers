# ADR-0001: v1 is read-only

Status: Accepted

## Decision
WeRead MCP v1 只暴露读取能力，所有 tool 标记 `readOnlyHint: true`。

## Consequences
写书架、写笔记、修改进度等能力需要单独设计与安全审查，不能在当前 tool 中偷偷增加。
