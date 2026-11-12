# Context Map

Independent application contexts:

- [GitHub Actions MCP](apps/github-actions-mcp-worker/CONTEXT.md): reviewed GitHub Actions administration.
- [Database MCP](apps/database-mcp-worker/README.md): database connections and SQL boundaries.
- [IMA MCP](apps/ima-mcp-worker/CONTEXT.md): notes and knowledge.
- [Raindrop MCP](apps/raindrop-mcp-worker/CONTEXT.md): bookmarks and collections.
- [Browser MCP](apps/browser-mcp-worker/CONTEXT.md): browser extension pairing, tabs and browser operation receipts.
- [Remote Control MCP](docs/remote-control/CONTEXT.md): signed per-device relay, local files/Shell and Agent-owned sessions; native Agent source lives in `apps/remote-control-mcp-worker/agent`.
- [SSH MCP](apps/ssh-mcp-worker/CONTEXT.md): scoped remote command execution.
- [Workflow MCP](apps/workflow-mcp-worker/README.md): orchestration, published grants and durable admission.
- [Cloudflare Actions](https://github.com/lirtual/cloudflare-actions/tree/main/apps/actions-worker): reviewed private Action Provider.

Contexts own their own credentials and release lifecycle. Shared Portal authentication does not authorize business effects.
