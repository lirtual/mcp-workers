# Context Map

The active repository contains independently owned MCP Worker bounded contexts:

- [GitHub Actions MCP](./apps/github-actions-mcp-worker/CONTEXT.md): owns allowlisted GitHub Actions management solely through GitHub REST API.

- [Workflow MCP (planned)](./apps/workflow-mcp-worker/CONTEXT.md): AI/MCP-first orchestration context; composes existing capabilities without owning upstream Workers' credentials, business semantics, or lifecycle. Rounds 1–6 decisions are recorded in app-scoped ADRs and the grilling log (runtime publishing/version pinning, non-preregistered MCP targets with operation approval waits, bounded typed DAG, encrypted target credentials, asynchronous Runs with truthful indeterminate outcomes, D1/R2 results and GitHub Attempt Claim); no implementation exists yet.

- [Database MCP](./apps/database-mcp-worker/README.md): owns database connection configuration, SQL safety, and database tool semantics.
- [IMA MCP](./apps/ima-mcp-worker/CONTEXT.md): owns IMA knowledge and notes operations.
- [Raindrop MCP](./apps/raindrop-mcp-worker/CONTEXT.md): owns Raindrop.io bookmark, collection, tag, highlight, and upstream API semantics.
- Remote Control MCP (`apps/remote-control-mcp-worker` and `apps/remote-control-agent`): owns the Portal ingress for one private Linux device and the curated relay to native Node.js file operations. Its implemented tool surface includes file reads, directory listing, search, receipt-protected `write_file`, `create_directory`, `edit_block`, and `move_file`, plus `get_operation_status`. Shell remains separately gated on the real Linux-user privilege review; code changes alone do not deploy or enable the live Worker/Portal connection.

Each context maintains its own application contract, upstream credentials, deployment lifecycle, and runtime behavior. The shared `packages/portal-auth` package is limited to the MCP ingress authentication boundary and does not centralize application business logic.
