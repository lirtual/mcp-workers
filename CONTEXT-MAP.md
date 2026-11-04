# Context Map

The active repository contains independently owned MCP Worker bounded contexts:

- [GitHub Actions MCP](./apps/github-actions-mcp-worker/CONTEXT.md): owns allowlisted GitHub Actions management solely through GitHub REST API.

- [Database MCP](./apps/database-mcp-worker/README.md): owns database connection configuration, SQL safety, and database tool semantics.
- [IMA MCP](./apps/ima-mcp-worker/CONTEXT.md): owns IMA knowledge and notes operations.
- [Raindrop MCP](./apps/raindrop-mcp-worker/CONTEXT.md): owns Raindrop.io bookmark, collection, tag, highlight, and upstream API semantics.
- [Browser MCP](./apps/browser-mcp-worker/CONTEXT.md): owns profile-scoped extension pairing, local control, WSS connection generation, task-scoped browser interaction with technical credential/Owner boundaries, Unknown owner review and browser receipts (Spec #418).

- [Remote Control MCP](./docs/remote-control/CONTEXT.md) (`apps/remote-control-mcp-worker` and `apps/remote-control-agent`): owns the authenticated Portal ingress and signed per-device relay for Windows x64, Linux x64/ARM64 (including WSL2), and macOS ARM64/x64 Agents. Its curated tools cover files, search, Shell, managed sessions and paired devices. Spec #628 retired all 13 RCA-owned Browser/Computer tools and executable routes, while preserving historical read-only operation receipts; independent Browser MCP #418 owns browser control. Browser Handoff (Spec #280) and the `upgrade_agent` MCP tool are retired; separately authorized, owner-controlled local or short-lived remote Shell upgrades use reviewed installers/OS tasks and preserve device identity.

- [Unified Cloudflare Actions](https://github.com/lirtual/cloudflare-actions/tree/main/apps/actions-worker) (Spec #21; Spec #54 retirement): the deployed `cloudflare-actions` Worker owns the reviewed Bark, Dub, EnvShare and Litterbox Action Catalog. The Workflow Consumer uses one private `ACTIONS` Service Binding; Spec #711 removes unnecessary permanent deployment-UUID pinning for compatible new dispatch while keeping observed invocation identities and original immutable Plan grants. This source change is **not** a production rollout. The current runtime denies historical Weixin Actions. See the [canonical Bark-only retirement ADR](https://github.com/lirtual/cloudflare-actions/blob/main/docs/adr/0002-bark-only-weixin-retirement.md) and [Spec #54](https://github.com/lirtual/cloudflare-actions/issues/54).

- **Bark Action:** a logical handler inside the unified `apps/actions-worker`, not a separate deployed Provider. The Workflow Consumer owns reviewed grants, live contract identity verification and at-most-once dispatch; the Provider owns AES-256-GCM Bark delivery.

- **Historical Weixin retirement:** legacy Weixin Action IDs and Owner HTTP endpoints are not present in the current executable Provider catalog. T7 #61 recorded completion of historical Provider and encryption-Secret retirement on 2026-11-04, separately from T3 classification; T8/T9 destructive D1 purge/irrecoverability were closed `not_planned`. Preserve historical Plans/receipts and Unknown no-replay behavior. T7 closure is issue-recorded evidence, not a new production readback or proof of arbitrary rollback safety.

Each context maintains its own application contract, upstream credentials, deployment lifecycle, and runtime behavior. The shared `packages/portal-auth` package is limited to the MCP ingress authentication boundary and does not centralize application business logic.
