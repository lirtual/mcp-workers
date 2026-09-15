# V1 Implementation Contract

Implement a TypeScript Cloudflare Worker that acts as a stateless OpenList REST → MCP adapter.

Required: MCP SDK v2 + `createMcpHandler`, `/mcp`, `/health`, Portal-to-Worker authentication with the app's dedicated `MCP_ACCESS_TOKEN`, upstream OpenList token auth with no Bearer prefix, explicit allowed paths, read-only tool omission, core filesystem tools, direct download URL, <=5 MiB base64 upload by default, basic OpenList task tools, structured errors, safe logging, CI, tests, and docs.

Security invariants: fail closed on Portal/path validation; consume the inbound Portal `Authorization` header before MCP/domain handling; never reuse `MCP_ACCESS_TOKEN` as `OPENLIST_TOKEN`; copy/move validate source and destination; rename result remains allowed; destructive remove/cancel/delete require `confirm=true`; no sensitive token/body/download URL logging; `workers.dev` disabled.

Retired client-auth compatibility: Worker-side Cloudflare Access JWT validation, `Cf-Access-Jwt-Assertion`, `CF_ACCESS_TEAM_DOMAIN`, and `CF_ACCESS_AUD` are not part of the target runtime contract.

Out of scope: Python runtime, McpAgent, protocol sessions, KV/D1/DO/R2/Queues/Cron, custom OAuth server, OpenList username/password/TOTP, large-file proxying/chunking, shares, offline download, archive tools, torrent, admin APIs, recursive smart tools, mirror, AList v3, multi-tenancy, staging, automatic production deployment.
