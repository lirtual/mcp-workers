# Context Map

The active repository contains independently owned MCP Worker bounded contexts:

- [GitHub Actions MCP](./apps/github-actions-mcp-worker/CONTEXT.md): owns allowlisted GitHub Actions management solely through GitHub REST API.

- [Email MCP](./apps/email-mcp-worker/CONTEXT.md): owns single-owner multi-mailbox credentials, message operations, and send retry safety.
- [HTTP MCP](./apps/http-mcp-worker/README.md): owns interactive public HTTP(S) debugging, bounded responses, and origin/path-scoped outbound credentials.
- [Database MCP](./apps/database-mcp-worker/README.md): owns database connection configuration, SQL safety, and database tool semantics.
- [IMA MCP](./apps/ima-mcp-worker/CONTEXT.md): owns IMA knowledge and notes operations.
- [Raindrop MCP](./apps/raindrop-mcp-worker/CONTEXT.md): owns Raindrop.io bookmark, collection, tag, highlight, and upstream API semantics.
- [Browser MCP](./apps/browser-mcp-worker/CONTEXT.md): owns profile-scoped extension pairing, local control, WSS connection generation, blocked consequential actions, Unknown owner review and browser receipts (Spec #418; T1 foundation is in progress).

- [Remote Control MCP](./docs/remote-control/CONTEXT.md) (`apps/remote-control-mcp-worker` and `apps/remote-control-agent`): owns the authenticated Portal ingress and signed per-device relay for Windows x64 and Linux x64/ARM64 Agents (including WSL2). Its curated tools cover files, Shell, managed sessions, paired devices, and ten Agent-owned browser operations with device-grant checks and operation receipts. Browser Handoff (Spec #280) and MCP-initiated Agent upgrades are retired; Agent upgrades use owner-interactive local installers.

- [Unified Cloudflare Actions (Spec #21)](https://github.com/lirtual/cloudflare-actions/tree/main/apps/actions-worker): source-only candidate for one physical Worker, static Weixin/Bark Action Catalog and one private `ACTIONS` Binding. Not yet deployed; historical read-only compatibility and a protected cutover are prerequisites. See [migration contract](./docs/spec-21-migration.md).

- [Bark Action Provider](https://github.com/lirtual/cloudflare-actions/tree/main/apps/bark-provider): owns a private single-device AES-256-GCM Bark send RPC; the Workflow consumer alone owns review grants, version pins and durable at-most-once admission. No Bark-specific database or receipt lookup.

- [Weixin Action Provider](https://github.com/lirtual/cloudflare-actions/tree/main/apps/weixin-mcp-worker): independently owns the original Weixin Worker, encrypted owner binding, D1 receipts and private RPC. The public MCP ingress and this repository's Weixin release path were retired by Spec #392.

Each context maintains its own application contract, upstream credentials, deployment lifecycle, and runtime behavior. The shared `packages/portal-auth` package is limited to the MCP ingress authentication boundary and does not centralize application business logic.
