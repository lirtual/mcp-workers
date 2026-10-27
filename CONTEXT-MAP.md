# Context Map

The active repository contains independently owned MCP Worker bounded contexts:

- [GitHub Actions MCP](./apps/github-actions-mcp-worker/CONTEXT.md): owns allowlisted GitHub Actions management solely through GitHub REST API.

- [Email MCP](./apps/email-mcp-worker/CONTEXT.md): owns single-owner multi-mailbox credentials, message operations, and send retry safety.
- [HTTP MCP](./apps/http-mcp-worker/README.md): owns interactive public HTTP(S) debugging, bounded responses, and origin/path-scoped outbound credentials.
- [Database MCP](./apps/database-mcp-worker/README.md): owns database connection configuration, SQL safety, and database tool semantics.
- [IMA MCP](./apps/ima-mcp-worker/CONTEXT.md): owns IMA knowledge and notes operations.
- [OpenList MCP](./apps/openlist-mcp-worker/CONTEXT.md): owns guarded virtual-tree operations to the existing OpenList-Worker through a private Service Binding.
- [Raindrop MCP](./apps/raindrop-mcp-worker/CONTEXT.md): owns Raindrop.io bookmark, collection, tag, highlight, and upstream API semantics.
- Remote Control MCP (`apps/remote-control-mcp-worker` and `apps/remote-control-agent`): owns the Portal ingress for one private Linux device and the curated relay to native Node.js file operations. Its implemented tool surface includes file reads, directory listing, search, receipt-protected `write_file`, `create_directory`, `edit_block`, and `move_file`, plus `get_operation_status`. Shell remains separately gated on the real Linux-user privilege review; code changes alone do not deploy or enable the live Worker/Portal connection.

- [Weixin MCP (PoC only)](./apps/weixin-mcp-worker/CONTEXT.md): owns single-owner Weixin iLink feasibility. No deployable Worker or production binding until verified live PoC.

Each context maintains its own application contract, upstream credentials, deployment lifecycle, and runtime behavior. The shared `packages/portal-auth` package is limited to the MCP ingress authentication boundary and does not centralize application business logic.
