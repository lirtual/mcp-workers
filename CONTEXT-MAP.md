# Context Map

The active repository contains three independently owned MCP Worker bounded contexts:

- [Database MCP](./apps/database-mcp-worker/README.md): owns database connection configuration, SQL safety, and database tool semantics.
- [IMA MCP](./apps/ima-mcp-worker/CONTEXT.md): owns IMA knowledge and notes operations.
- [Raindrop MCP](./apps/raindrop-mcp-worker/CONTEXT.md): owns Raindrop.io bookmark, collection, tag, highlight, and upstream API semantics.

Each context maintains its own application contract, upstream credentials, deployment lifecycle, and runtime behavior. The shared `packages/portal-auth` package is limited to the MCP ingress authentication boundary and does not centralize application business logic.

## Contexts under design

- [Remote Control MCP](./docs/remote-control/CONTEXT.md): proposed single-user, Linux-first remote host control MCP. Formal specification: [SPEC.md](./docs/remote-control/SPEC.md), research provenance: [RESEARCH-DRAFT.md](./docs/remote-control/RESEARCH-DRAFT.md). It is **not yet an active app**, and no execution privileges, ingress changes, or production deployment are approved.
