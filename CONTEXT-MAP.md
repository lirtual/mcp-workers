# Context Map

The active repository contains independently owned MCP Worker bounded contexts:

- [Database MCP](./apps/database-mcp-worker/README.md): owns database connection configuration, SQL safety, and database tool semantics.
- [IMA MCP](./apps/ima-mcp-worker/CONTEXT.md): owns IMA knowledge and notes operations.
- [Raindrop MCP](./apps/raindrop-mcp-worker/CONTEXT.md): owns Raindrop.io bookmark, collection, tag, highlight, and upstream API semantics.
- Remote Control MCP (`apps/remote-control-mcp-worker` and `apps/remote-control-agent`): owns the Portal ingress for one private Linux device and the curated relay to a native Node.js `read_file`. T01R exposes only that local read.

Each context maintains its own application contract, upstream credentials, deployment lifecycle, and runtime behavior. The shared `packages/portal-auth` package is limited to the MCP ingress authentication boundary and does not centralize application business logic.
