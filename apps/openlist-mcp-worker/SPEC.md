# V1 Implementation Contract

Implement a TypeScript Cloudflare Worker that acts as a stateless OpenList REST → MCP adapter.

Required: MCP SDK v2 + `createMcpHandler`, `/mcp`, `/health`, Cloudflare Access JWT validation, upstream token auth with no Bearer prefix, explicit allowed paths, read-only tool omission, core filesystem tools, direct download URL, <=5 MiB base64 upload by default, basic OpenList task tools, structured errors, safe logging, CI, tests, and docs.

Security invariants: fail closed on Access/path validation; copy/move validate source and destination; rename result remains allowed; destructive remove/cancel/delete require `confirm=true`; no sensitive token/body/download URL logging; `workers.dev` disabled.

Out of scope: Python runtime, McpAgent, protocol sessions, KV/D1/DO/R2/Queues/Cron, custom OAuth server, OpenList username/password/TOTP, large-file proxying/chunking, shares, offline download, archive tools, torrent, admin APIs, recursive smart tools, mirror, AList v3, multi-tenancy, staging, automatic production deployment.
