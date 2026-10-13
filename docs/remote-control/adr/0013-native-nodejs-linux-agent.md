# ADR-0013 — Native Node.js Linux Agent, no Desktop Commander runtime

Status: accepted. Date: 2026-10-12. Operator explicitly selected the proposed native Linux Agent alternative after T01 had already been merged to main. This **supersedes the local execution-engine dependency** described in the existing v1 Spec and T01, but does not invalidate T01's already-delivered Worker/Agent read-only communication and authentication proof.

## Context

The earlier design copied the layered Remote Desktop Commander architecture: a cloud MCP relay, a host-side adapter, and the separate `@wonderwhy-er/desktop-commander` stdio engine for file/search/Shell operations. T01 (#3, closed; commit `ce2bb8211ebe50863af34ebf8566ddf8764be817`) implemented a small read-only vertical slice using a pinned `@wonderwhy-er/desktop-commander@0.2.52` subprocess and `@modelcontextprotocol/client` inside the Agent.

The operator clarified that Remote Desktop Commander was **an architectural reference**, not a mandatory runtime dependency. They prefer an independently owned, smaller execution stack for a single-user Linux environment.

## Decision

1. Keep the externally visible v1 features, Cloudflare MCP Worker, existing `@mcp-workers/portal-auth` + independent Bearer secret (ADR-0012), single private VPC Service/Tunnel target (ADR-0004), device-only credential, existing Linux account/no container/no directory allowlist (ADR-0011), curated tool names, operation receipts (ADR-0007) and Agent-owned sessions (ADR-0009).
2. Replace the Agent's `DesktopCommanderSession` stdio subprocess with **native Node.js file and process operations**. Implement files and directories using Node `fs/promises` and streaming APIs; implement file-name/text-content search with bounded traversal/streaming; implement Linux Shell and owned sessions using `child_process.spawn`, pipes and explicit process ownership.
3. The **Worker alone speaks MCP to the remote client**. The Agent remains a small private HTTP execution endpoint and does not run a second MCP transport. No `@wonderwhy-er/desktop-commander` runtime package, `@modelcontextprotocol/client` Agent dependency, vendor remote device, vendor cloud endpoint, or vendor telemetry/history mechanism in the final v1 Agent.
4. Continue to expose a **reviewed subset of equivalent tool contracts** (e.g. `read_file`, `start_process`, `list_sessions`) through Worker and Agent validation. Tool names are *our product contract*, not pass-through promises of byte-for-byte Desktop Commander compatibility.
5. Keep mutation deduplication at a single Agent-controlled receipt store, session ownership and bounded output at the Agent, without another layer of upstream process sessions. Reuse the existing implementation boundaries; do not introduce speculative executor interfaces for interchangeable third-party engines.
6. Preserve the **closed T01 evidence and commit**. Add one bounded post-T01 prerequisite ticket that replaces `read_file` with a native `fs` implementation, deletes the now-unused runtime packages/stdio code, and tests the same external authenticated read-only seam. T02 real Portal/ChatGPT read-only acceptance **must not start** until this prerequisite is accepted; its original T01 blocker remains historical.
7. Node child processes use pipes for input/output in v1; **interactive full-TTY/PTY emulation is not promised**. Do not create a terminal emulator or process-manager framework merely to copy upstream behavior.
8. The owner explicitly chose to change the design, **not** to deploy, touch real host credentials, enable Shell, create cloud resources, rewrite Git history, or close the parent Spec issue.

## Trade-offs

**Benefits:** fewer runtime processes and third-party dependencies, no second stdio MCP protocol, no vendor-local unredacted tool-history mechanism, no reconciliation against vendor PID sessions, and direct control of request validation/logging.

**Costs:** the Agent now owns filesystem pagination/error handling, search resource bounds, process lifecycle/identity, graceful group termination and stdout/stderr buffering. These must be tested via stable external Worker/Agent interfaces with disposable fixtures; native APIs alone do not guarantee safe idempotence or session ownership.

**Security invariant:** arbitrary Shell still has the full effective permissions of the existing Linux login user; deleting a third-party engine **does not create a sandbox**. Worker/Agent logs, input/output and local receipts still need privacy limits.

## Rejected option

Retain `@wonderwhy-er/desktop-commander` as a pinned stdio subprocess for all future file/search/Shell operations, and introduce a second layer of process tracking.

## Implementation authority

This ADR changes the approved **technical direction** only. Follow the updated Spec Issue #2 and affected tickets; do not modify production infrastructure or enable new remote capabilities without the separately required approvals.
