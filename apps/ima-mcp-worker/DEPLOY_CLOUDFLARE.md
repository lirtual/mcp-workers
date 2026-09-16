# Cloudflare deployment

This project uses one production architecture: Cloudflare MCP Portal in front of `ima-mcp-worker`, Worker Secrets for IMA/Portal credentials, and R2 for exported files. Export downloads are served directly by the R2 custom domain; the Worker is not a download proxy.

## 1. Requirements

- Cloudflare account
- Node.js 24 + pnpm 10
- Wrangler login or equivalent Cloudflare Dashboard access
- IMA OpenAPI Client ID and API Key
- Cloudflare MCP Portal

## 2. Install dependencies

From the monorepo root:

```bash
pnpm install --frozen-lockfile
```

## 3. R2 bucket and custom domain

The production bucket name is `ima-mcp-worker` and the Worker binding is `R2_BUCKET`.

```bash
pnpm --filter ima-mcp-worker exec wrangler r2 bucket create ima-mcp-worker
```

`wrangler.jsonc` already declares the `R2_BUCKET` binding. If the bucket already exists, do not recreate it.

Bind the R2 bucket to the public custom domain used for exported files. Current production value:

```text
https://temp.lirtual.dpdns.org
```

Set the Worker non-secret variable:

```text
R2_PUBLIC_BASE_URL=https://temp.lirtual.dpdns.org
```

`wrangler.jsonc` sets `keep_vars: true`, so Dashboard-managed plain-text variables such as `R2_PUBLIC_BASE_URL` are preserved across deployments.

If automatic cleanup is desired, configure an R2 Object Lifecycle Rule for objects under `exports/`.

## 4. Required Worker Secrets

```bash
pnpm --filter ima-mcp-worker exec wrangler secret put CLIENT_ID
pnpm --filter ima-mcp-worker exec wrangler secret put API_KEY
pnpm --filter ima-mcp-worker exec wrangler secret put MCP_ACCESS_TOKEN
```

Credential roles:

- `CLIENT_ID`: IMA OpenAPI Client ID.
- `API_KEY`: IMA OpenAPI API Key.
- `MCP_ACCESS_TOKEN`: independent Portal-to-Worker bearer token for this Worker.

Retired names are not supported: `IMA_OPENAPI_CLIENTID`, `IMA_OPENAPI_APIKEY`, `CLIENTID`, `APIKEY`, `IMA_DOWNLOAD_SIGNING_KEY`, and `PUBLIC_BASE_URL`.

## 5. Optional variables

- `IMA_BASE_URL`: overrides the default `https://ima.qq.com` endpoint.
- `FILE_DOWNLOAD_TIMEOUT_MS`
- `FILE_DOWNLOAD_MAX_REDIRECTS`
- `FILE_DOWNLOAD_MAX_BUFFER_BYTES`
- `IMA_RESPONSE_MAX_BYTES`

No `AUTH_MODE`, `OAUTH_MASTER_KEY`, OAuth redirect allowlist, D1 database, download-signing secret, or Worker download route is required.

## 6. Deploy

Production deployment is performed by the configured Cloudflare Build for this app. For a local dry run:

```bash
pnpm --filter ima-mcp-worker run deploy:dry-run
```

The Worker endpoint remains:

```text
https://ima-mcp-worker.<workers-subdomain>.workers.dev/mcp
```

The checked-in configuration explicitly keeps:

- `workers_dev: true`
- `preview_urls: false`
- `keep_vars: true`
- Workers Observability enabled with invocation logs

After deployment, verify:

- Secrets `CLIENT_ID`, `API_KEY`, `MCP_ACCESS_TOKEN` exist.
- R2 binding `R2_BUCKET` points to bucket `ima-mcp-worker`.
- `R2_PUBLIC_BASE_URL` is still present and points to the R2 custom domain.
- `workers.dev` is enabled.
- Workers Observability is enabled.

## 7. Verify health and readiness

```bash
curl https://ima-mcp-worker.<workers-subdomain>.workers.dev/health
curl https://ima-mcp-worker.<workers-subdomain>.workers.dev/ready
```

Expected readiness response:

```json
{"ready":true}
```

If required configuration is missing, `/ready` returns HTTP 503 and lists only missing binding/variable names.

## 8. Verify Portal authentication

A direct `/mcp` request without the bearer must be rejected:

```bash
curl -i -X POST https://ima-mcp-worker.<workers-subdomain>.workers.dev/mcp
```

Expected when `MCP_ACCESS_TOKEN` is configured: HTTP 401 with `WWW-Authenticate: Bearer`.

## 9. Configure Cloudflare MCP Portal

1. Add the Worker `/mcp` endpoint.
2. Set upstream authentication to Bearer.
3. Use the exact `MCP_ACCESS_TOKEN` value.
4. Do not configure Worker-owned OAuth, Dynamic Client Registration, PKCE, or per-user IMA BYOK.
5. Sync capabilities and verify the expected tools.

## 10. Verify export downloads

Generate an export through MCP. The returned URL should point directly to the R2 custom domain, for example:

```text
https://temp.lirtual.dpdns.org/exports/notes/<id>/<export-id>/<filename>
```

Acceptance checks:

1. The URL host is the configured `R2_PUBLIC_BASE_URL`, not the Worker host.
2. The URL contains no MCP or IMA credentials.
3. The object downloads directly from R2.
4. Re-exporting the same item creates a different R2 key because each export includes a generated UUID.
5. `/download/...` on the Worker returns normal 404 behavior.

## 11. Local development

```bash
cp apps/ima-mcp-worker/.dev.vars.example apps/ima-mcp-worker/.dev.vars
pnpm --filter ima-mcp-worker run dev
```

Populate `CLIENT_ID`, `API_KEY`, `MCP_ACCESS_TOKEN`, and a suitable local/test `R2_PUBLIC_BASE_URL` before testing the complete runtime contract.
