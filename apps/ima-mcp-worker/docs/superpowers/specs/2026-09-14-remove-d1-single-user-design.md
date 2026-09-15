# D1-less Single-User MCP Portal Design

## Goal

Simplify the IMA MCP deployment for one operator behind Cloudflare MCP Portal by removing Worker-owned OAuth and D1, using Worker Secrets `CLIENT_ID` and `API_KEY` for IMA OpenAPI, protecting `/mcp` with `MCP_ACCESS_TOKEN`, and moving export storage from R2 bucket `ima-exports` to `ima-mcp`.

## Final naming contract

| Resource | Final name |
|---|---|
| GitHub repository target | `lirtual/ima-mcp-worker` |
| Cloudflare Worker service | `ima-mcp` |
| R2 bucket | `ima-mcp` |
| R2 binding | `R2_BUCKET` |
| IMA Client ID secret | `CLIENT_ID` |
| IMA API key secret | `API_KEY` |
| Portal-to-Worker bearer | `MCP_ACCESS_TOKEN` |

The repository name, Worker service, bucket name, binding, and secret names are independent identifiers.

## Target architecture

```text
ChatGPT / MCP client
  -> Cloudflare MCP Portal + Access
  -> Authorization: Bearer <MCP_ACCESS_TOKEN>
  -> ima-mcp Worker /mcp
  -> Worker Secrets: CLIENT_ID + API_KEY
  -> IMA OpenAPI

ima-mcp Worker
  -> R2_BUCKET
  -> R2 bucket ima-mcp
```

The Worker is stateless for authentication. It does not maintain OAuth client registrations, authorization codes, access/refresh tokens, user-to-credential mappings, or encrypted IMA credentials in D1.

## Authentication model

There are three separate security identities:

1. **Portal/client identity** — Cloudflare Access authenticates the client to the Portal.
2. **Origin credential** — `MCP_ACCESS_TOKEN` authenticates Portal requests to the Worker.
3. **IMA business credential** — `CLIENT_ID` and `API_KEY` authenticate Worker requests to IMA OpenAPI.

No credential may substitute for another layer.

Required production Worker Secrets:

- `CLIENT_ID`
- `API_KEY`
- `MCP_ACCESS_TOKEN`

Retired names are not supported and must not be treated as aliases:

- `IMA_OPENAPI_CLIENTID`
- `IMA_OPENAPI_APIKEY`
- `CLIENTID`
- `APIKEY`
- `OAUTH_MASTER_KEY`
- `AUTH_MODE`

## D1 and OAuth removal

Remove D1 completely from the active application:

- remove `DB: D1Database` from `Env`;
- remove the D1 binding from `wrangler.jsonc`;
- remove D1 create/migration scripts from `package.json`;
- delete D1 migration files;
- delete `src/auth.ts`, `src/oauth.ts`, and `src/credential-vault.ts` once no longer referenced;
- remove OAuth/D1-only crypto helpers while retaining any crypto still required by IMA/COS business logic;
- remove OAuth/D1-only contract tests;
- replace D1-backed readiness with stateless configuration readiness.

The old external D1 database is not deleted automatically by code deployment. It may be removed manually only after production acceptance.

The Worker-owned OAuth surface is retired entirely, including discovery, DCR, authorize, token, refresh, revoke, disconnect, PKCE, and `ima.read` / `ima.write` scope handling. Retired paths return ordinary 404 behavior.

## Worker behavior

### `/health`

Return public liveness metadata, identify the deployment as single-user, do not access D1, and do not expose secret values.

### `/ready`

Return `200` only when every supported production capability is configured:

- `MCP_ACCESS_TOKEN`;
- `CLIENT_ID`;
- `API_KEY`;
- `R2_BUCKET`;
- any required image-refresh Durable Object binding if that feature is present.

On failure, return HTTP 503 with missing capability names only. R2 is part of readiness because export is part of the supported MCP surface.

### `/mcp`

- missing Worker-side `MCP_ACCESS_TOKEN` -> fail closed with server configuration error;
- missing or incorrect request bearer -> HTTP 401 with `WWW-Authenticate: Bearer`;
- missing `CLIENT_ID` / `API_KEY` -> server configuration error;
- valid origin bearer and IMA secrets -> construct one `ImaCredentials` object from Worker Secrets and invoke the normal MCP handler;
- authorized single-user requests retain the existing read/write tool surface; no replacement role or scope system is introduced.

### `/download/:key`

Preserve existing R2-backed download behavior. Missing `R2_BUCKET` remains an explicit configuration failure; no fallback storage is added.

## R2 bucket change

The production R2 bucket is `ima-mcp`; the application binding remains `R2_BUCKET`.

Operational cutover:

1. create or select R2 bucket `ima-mcp`;
2. bind it as `R2_BUCKET` to Worker `ima-mcp`;
3. deploy;
4. verify the deployed Worker still has the binding;
5. verify an export lands in `ima-mcp`;
6. keep `ima-exports` intact until historical objects are no longer needed.

Object-key format remains unchanged under `exports/...`. Do not redesign export result schemas, metadata, or custom-domain/download semantics.

## Durable Object boundary

Removing D1 does not imply removing a Durable Object used by the image-refresh feature. If present, that Durable Object remains an execution shard for Workers Free subrequest budgeting and must not persist `CLIENT_ID`, `API_KEY`, Markdown, image URLs, or authentication state.

## Files expected to change

- `src/index.ts` — one single-user bearer path, stateless readiness, no OAuth routing.
- `src/types.ts` — no D1/OAuth-only environment or session types; use `CLIENT_ID` / `API_KEY`.
- `src/crypto.ts` — retain only business crypto still imported by IMA/COS logic.
- `wrangler.jsonc` — Worker remains `ima-mcp`, no D1 binding, `R2_BUCKET` targets `ima-mcp`.
- `package.json` — no D1 lifecycle scripts.
- `.dev.vars.example` — final secret names only.
- `README.md`, `DEPLOY_CLOUDFLARE.md`, `docs/mcp-portal.md`, `CONTEXT.md` — one Portal-first single-user architecture.
- `test/contract` — Worker-boundary authentication/readiness tests replace OAuth/D1 tests.
- D1 migrations and OAuth/vault implementation files — removed.

## Security constraints

- Never commit `CLIENT_ID`, `API_KEY`, or `MCP_ACCESS_TOKEN` values.
- Never log Authorization headers or IMA credentials.
- Never accept `API_KEY` as the origin bearer.
- Keep Portal/client authentication separate from the Worker origin bearer.
- Preserve origin-hostname checks as defense in depth.
- Do not document the raw Worker as the normal client ingress once Portal is configured.

## Test strategy

Verify through the highest available public seams:

1. `/mcp` rejects missing/wrong bearer values.
2. missing server-side `MCP_ACCESS_TOKEN` fails closed.
3. Worker obtains IMA credentials only from `CLIENT_ID` / `API_KEY`.
4. retired IMA secret names do not satisfy configuration.
5. `/ready` requires the origin token, both IMA secrets, and `R2_BUCKET` without D1.
6. `/health` and `/ready` work with no `DB` binding.
7. retired OAuth routes return 404.
8. existing tool discovery, representative read/write behavior, R2 export, file-ingestion safety, and destructive-operation guards remain intact.
9. typecheck succeeds with no `D1Database` requirement.
10. full test suite passes before merge.

## Deployment sequence

1. Create/select R2 bucket `ima-mcp`.
2. Configure Worker Secrets `CLIENT_ID`, `API_KEY`, and `MCP_ACCESS_TOKEN`.
3. Deploy Worker service `ima-mcp` with `R2_BUCKET` bound to `ima-mcp`.
4. Configure the MCP Portal upstream server with authentication type `bearer` and the exact `MCP_ACCESS_TOKEN` value.
5. Verify raw `/mcp` without bearer fails.
6. Verify Portal capability sync and tool discovery.
7. Verify one representative read, one safe write, and one export through the Portal.
8. Verify `/ready` is healthy and logs contain no credential values.
9. Only after acceptance, optionally remove the old D1 database and old `ima-exports` bucket.

## Acceptance criteria

- No active D1 binding, migration, runtime call, or D1-specific type remains.
- No Worker-owned OAuth endpoint or OAuth state implementation remains.
- `CLIENT_ID` and `API_KEY` are the only supported IMA credential names.
- `/mcp` is protected by mandatory `MCP_ACCESS_TOKEN`.
- `/ready` requires the supported runtime secrets and R2 binding.
- R2 binding points to bucket `ima-mcp` while export semantics stay unchanged.
- Worker service remains `ima-mcp`; repository rename target is `ima-mcp-worker`.
- Existing external D1 and `ima-exports` resources are not automatically destroyed.
- Full typecheck and test suite pass before merge.
