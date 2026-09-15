# OpenList MCP Worker

A small, policy-enforcing OpenList REST → MCP adapter for Cloudflare Workers.

## V1 scope

The Worker exposes a bounded core tool set: capability discovery, file listing/info/search, mkdir/rename/copy/move/remove, direct download URL lookup, small base64 uploads, and basic OpenList task management. It intentionally does not implement recursive smart tools, large-file proxying, shares, offline download, torrent, admin APIs, D1, Durable Objects, R2, or custom OAuth state.

## Architecture

OpenList is in the **expand** phase of the Portal-first migration:

```text
MCP client
  -> Cloudflare MCP Portal + Managed OAuth / Access
  -> Authorization: Bearer <MCP_ORIGIN_TOKEN>
  -> OpenList MCP Worker /mcp
  -> OPENLIST_TOKEN
  -> OpenList API
```

During the expand phase, the existing Cloudflare Access assertion path remains available for rollback. The Worker therefore accepts either:

- a valid dedicated Portal origin bearer (`MCP_ORIGIN_TOKEN`); or
- the existing `Cf-Access-Jwt-Assertion` path.

A supplied but invalid bearer is rejected and never falls through to Access authentication.

The Worker strips a valid Portal `Authorization` header before MCP/domain handling. `OPENLIST_TOKEN` remains a separate raw/non-Bearer Worker-to-OpenList business credential.

## Required configuration

Set non-secret vars in Cloudflare/Wrangler:

- `OPENLIST_URL` — HTTPS URL of the OpenList server
- `OPENLIST_ALLOWED_PATHS` — comma-separated roots, e.g. `/documents,/media`
- `CF_ACCESS_TEAM_DOMAIN` — legacy expand-phase Access team domain
- `CF_ACCESS_AUD` — legacy expand-phase Access application audience tag

Set independent secrets:

```sh
npx wrangler secret put OPENLIST_TOKEN
npx wrangler secret put MCP_ORIGIN_TOKEN
```

Never reuse either secret for the other purpose.

Optional vars:

- `OPENLIST_READONLY` — defaults to `true`; set `false` to register write tools
- `OPENLIST_UPLOAD_MAX_BYTES` — defaults to `5242880` (5 MiB)
- `OPENLIST_TIMEOUT_MS` — defaults to `15000`

`wrangler.jsonc` intentionally sets `workers_dev=false`; production should use the intended custom hostname. Portal clients connect to the Portal URL rather than the raw Worker hostname.

## Migration and Cloudflare Access

Keep the existing Access application and Worker JWT verification during the expand phase. Add the Worker `/mcp` custom-domain URL to Cloudflare MCP Portal with Bearer upstream authentication using `MCP_ORIGIN_TOKEN`.

After Portal discovery, read-only behavior, path restrictions, and representative operations are verified, the follow-up contract ticket can remove the Worker-side Access JWT path. Domain security controls remain regardless of ingress.

See `docs/deployment.md` for the rollout and acceptance sequence.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
npx wrangler dev
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

Ingress authentication, the low-privilege OpenList account/token, and the path allowlist are separate controls. Portal authentication is not a replacement for OpenList authorization or path policy. `confirm=true` on destructive operations is an additional accidental-operation guard, not an authorization boundary.

In read-only mode, mutation tools are omitted from tool discovery entirely.

## Attribution

Behavior and endpoint semantics were informed by the MIT-licensed `hbestm/openlist-mcp-server` project and the OpenList v4 API documentation. This implementation is a new TypeScript Worker runtime rather than a direct runtime port.
