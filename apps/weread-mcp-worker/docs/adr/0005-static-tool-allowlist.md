# ADR-0005: Static domain tool allowlist

Status: Accepted

## Decision
MCP tools 与允许访问的腾讯 API 均静态定义。`/_list` 只用于维护诊断。

## Consequences
腾讯新增 endpoint 不会自动扩大 MCP 权限面；新增能力必须显式审查和发布。
