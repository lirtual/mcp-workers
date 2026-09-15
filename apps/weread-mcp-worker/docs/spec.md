# WeRead MCP v1 implementation contract

本实现遵循以下冻结边界：

- 腾讯官方 Agent API，Skill 1.0.4
- Cloudflare stateless `createMcpHandler()`
- 10 个领域级只读 tools
- `WeReadClient` 单一腾讯协议边界
- endpoint-specific continuation
- `upgrade_info` fail closed
- 10 秒上游 timeout
- 网络瞬时异常与 502/503/504 最多重试一次；429 不重试
- zero persistence
- production Service Binding only
- 不提供 `search`/`fetch` 重复兼容 tools
- 不负责 Markdown/PDF/Obsidian 文件生成
