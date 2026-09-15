# OpenList MCP Worker

A small, policy-enforcing OpenList REST → MCP adapter for Cloudflare Workers.

## V1 scope

The Worker exposes a bounded core tool set: capability discovery, file listing/info/search, mkdir/rename/copy/move/remove, direct download URL lookup, small base64 uploads, and basic OpenList task management. It intentionally does not implement recursive smart tools, large-file proxying, shares, offline download, torrent, admin APIs, D1, Durable Objects, R2, or custom OAuth state.

## Architecture

The monorepo target is Portal-only client ingress:

```text
MCP client
  -> Cloudflare MCP Portal
  -> Authorization: Bearer <MCP_ACCESS_TOKEN>
  -> OpenList MCP Worker /mcp
  -> OPENLIST_TOKEN
  -> OpenList API
```

`MCP_ACCESS_TOKEN` is this Worker's dedicated Portal-to-Worker machine credential. The Worker consumes that `Authorization` header before MCP/domain handling. `OPENLIST_TOKEN` remains a separate raw/non-Bearer Worker-to-OpenList business credential and must never be reused as the Portal credential.

The retired Worker-side Cloudflare Access JWT path (`Cf-Access-Jwt-Assertion`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`) is not a supported client authentication path.

## Required configuration

Set non-secret vars in Cloudflare/Wrangler:

- `OPENLIST_URL` — HTTPS URL of the OpenList server
- `OPENLIST_ALLOWED_PATHS` — comma-separated roots, e.g. `/documents,/media`

Set independent secrets:

```sh
pnpm exec wrangler secret put OPENLIST_TOKEN
pnpm exec wrangler secret put MCP_ACCESS_TOKEN
```

Never reuse either secret for the other purpose, and do not share `MCP_ACCESS_TOKEN` with another Worker.

Optional vars:

- `OPENLIST_READONLY` — defaults to `true`; set `false` to register write tools
- `OPENLIST_UPLOAD_MAX_BYTES` — defaults to `5242880` (5 MiB)
- `OPENLIST_TIMEOUT_MS` — defaults to `15000`

`wrangler.jsonc` intentionally sets `workers_dev=false`; keep the existing intended Worker routing for any deployment of this app. Portal clients connect to the Portal URL rather than treating the raw Worker as a second client-auth surface.

See `docs/deployment.md` for the deployment and acceptance contract.

## Development

```sh
pnpm install --frozen-lockfile
pnpm --filter openlist-mcp-worker check
pnpm --filter openlist-mcp-worker dev
```

The production OpenList URL is required to use HTTPS. For local integration testing, use a reachable HTTPS OpenList test instance.

## MCP endpoint

```text
POST /mcp
```

Health check:

```text
GET /health
```

The health route does not contact OpenList or reveal backend details.

## Safety model

Portal authentication, the low-privilege OpenList account/token, and the path allowlist are separate controls. Portal authentication is not a replacement for OpenList authorization or path policy. `confirm=true` on destructive operations is an additional accidental-operation guard, not an authorization boundary.

In read-only mode, mutation tools are omitted from tool discovery entirely.

## Attribution

Behavior and endpoint semantics were informed by the MIT-licensed `hbestm/openlist-mcp-server` project and the OpenList v4 API documentation. This implementation is a new TypeScript Worker runtime rather than a direct runtime port.
