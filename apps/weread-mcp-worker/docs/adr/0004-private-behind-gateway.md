# ADR-0004: Private service behind the existing gateway

Status: Superseded

## Historical decision

WeRead Worker 最初设计为无公开 route，通过 Cloudflare Service Binding 被既有认证 Gateway 调用。

## Superseded by

Monorepo Portal-only 入口契约取代该生产入口：Cloudflare MCP Portal 使用每个 Worker 独立的 `MCP_ACCESS_TOKEN` 访问 `/mcp`，Worker 校验后移除入口 `Authorization`，再进入 MCP handler。微信读书上游继续独立使用 `WEREAD_API_KEY`。

旧 Gateway / Service Binding 与 `MCP_ORIGIN_TOKEN` 不再属于当前 WeRead 运行契约。
