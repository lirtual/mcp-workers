# ADR-0004: Private service behind the existing gateway

Status: Accepted

## Decision
生产 WeRead Worker 无公开 route，通过 Cloudflare Service Binding 被现有认证 Gateway 调用。

## Consequences
客户端认证与微信读书 API Key 完全分层，无法绕过 Gateway 直接使用私有 WeRead credential。
