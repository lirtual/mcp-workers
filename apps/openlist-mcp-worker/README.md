# OpenList MCP Worker

A small, policy-enforcing OpenList REST → MCP adapter for Cloudflare Workers.

## Current architecture

```text
MCP client
  -> Cloudflare MCP Portal
  -> Authorization: Bearer <MCP_ACCESS_TOKEN>
  -> https://openlist-mcp-worker.<workers-subdomain>.workers.dev/mcp
  -> OPENLIST_TOKEN
  -> OpenList API
```

The Worker is stateless. `MCP_ACCESS_TOKEN` is the dedicated Portal-to-Worker credential and is consumed before MCP/domain handling. `OPENLIST_TOKEN` is a separate raw/non-Bearer Worker-to-OpenList credential and must never be reused as the Portal credential.

`wrangler.jsonc` follows the monorepo ingress policy:

- `workers_dev: true`
- `preview_urls: false`
- no custom domain or zone route is required for the target Worker ingress

Cloudflare Access JWT handling, `Cf-Access-Jwt-Assertion`, `CF_ACCESS_TEAM_DOMAIN`, and `CF_ACCESS_AUD` are retired Worker client-auth paths.

## Capability scope

The Worker exposes a bounded OpenList tool set for capability discovery, file listing/info/search, mkdir/rename/copy/move/remove, direct download URL lookup, small base64 uploads, and basic OpenList task management. It intentionally does not implement recursive smart tools, large-file proxying, shares, offline download, torrent, admin APIs, D1, Durable Objects, R2, or custom OAuth state.

Configuration:

- `OPENLIST_URL` — HTTPS OpenList server URL
- `OPENLIST_ALLOWED_PATHS` — comma-separated allowed roots
- `OPENLIST_READONLY` — defaults to `true`; mutation tools are omitted when enabled
- `OPENLIST_UPLOAD_MAX_BYTES` — defaults to 5 MiB
- `OPENLIST_TIMEOUT_MS` — defaults to 15 seconds
- `OPENLIST_TOKEN` — Worker secret for OpenList business authentication
- `MCP_ACCESS_TOKEN` — independent Worker secret for Portal ingress

## Safety model

Portal authentication, the low-privilege OpenList account/token, and the path allowlist are separate controls. Copy/move validate both source and destination. Destructive remove/cancel/delete operations require `confirm=true`, but confirmation is an accidental-operation guard rather than an authorization boundary. Download bodies do not transit the Worker.

## Development and verification

```sh
pnpm install --frozen-lockfile
pnpm --filter openlist-mcp-worker check
pnpm --filter openlist-mcp-worker dev
```

Repository CI is owned by the monorepo root workflow; this app does not maintain a nested GitHub Actions pipeline.

See `docs/deployment.md` for deployment/acceptance details and `CONTEXT.md` for durable domain invariants.

## Production cutover boundary

The repository target is the Worker above, but repository cleanup does **not** itself replace the separately operating OpenList Tunnel/local-service production topology. Any production Portal upstream switch is a distinct final cutover action that must be validated separately.

## Attribution

Behavior and endpoint semantics were informed by the OpenList API and the source history recorded in `SOURCE.md`. No license is invented for a source snapshot that did not declare one.
