# ADR-0001: Stateless Cloudflare MCP Runtime

**Status:** Accepted

## Context
The target is a Remote MCP server on Cloudflare Workers. The source/reference implementation is Python/process oriented, while current Cloudflare MCP guidance uses the v2 MCP server package and stateless `createMcpHandler()`.

## Decision
Use TypeScript, Cloudflare Workers, MCP SDK v2, and `createMcpHandler()` with stateless Streamable HTTP. Do not use Python Workers, `McpAgent`, Durable Object MCP sessions, or standalone legacy SSE sessions.

## Consequences
The runtime matches Cloudflare's native execution model and has no protocol session persistence. Stateful features must be explicitly justified later rather than emerging accidentally.
