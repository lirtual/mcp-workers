# Cloudflare deployment

This project uses one production architecture: Cloudflare MCP Portal in front of the `ima-mcp-worker` Worker, a static per-Worker bearer credential, Worker Secrets for IMA credentials, and R2 for exports. D1 and Worker-owned OAuth are not used.

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

## 3. Create the R2 bucket

The production bucket name is `ima-mcp-worker` and the Worker binding is `R2_BUCKET`.

```bash
pnpm --filter ima-mcp-worker exec wrangler r2 bucket create ima-mcp-worker
```

`wrangler.jsonc` already declares:

```json
{
  "binding": "R2_BUCKET",
  "bucket_name": "ima-mcp-worker"
}
```

If the bucket already exists, do not recreate it. The old `ima-exports` bucket is not deleted automatically; keep it until historical objects are no longer needed.

## 4. Configure Worker Secrets

Required secrets:

```bash
pnpm --filter ima-mcp-worker exec wrangler secret put CLIENT_ID
pnpm --filter ima-mcp-worker exec wrangler secret put API_KEY
pnpm --filter ima-mcp-worker exec wrangler secret put MCP_ACCESS_TOKEN
```

The same values can be entered in Cloudflare Dashboard under the Worker's Variables and Secrets settings.

Credential roles are intentionally separate:

- `CLIENT_ID`: IMA OpenAPI Client ID.
- `API_KEY`: IMA OpenAPI API Key.
- `MCP_ACCESS_TOKEN`: independent Portal-to-Worker bearer token for this Worker.

Do not reuse the IMA API key as `MCP_ACCESS_TOKEN`, and do not reuse this Worker's access token for another Worker.

Retired names are not supported: `IMA_OPENAPI_CLIENTID`, `IMA_OPENAPI_APIKEY`, `CLIENTID`, and `APIKEY`.

## 5. Optional variables

- `IMA_BASE_URL`: overrides the default `https://ima.qq.com` endpoint.
- `PUBLIC_BASE_URL`: overrides the Worker origin used for generated download links.
- `R2_CUSTOM_DOMAIN`: direct-download domain for R2 objects.
- `FILE_DOWNLOAD_TIMEOUT_MS`, `FILE_DOWNLOAD_MAX_REDIRECTS`, `FILE_DOWNLOAD_MAX_BUFFER_BYTES`, `IMA_RESPONSE_MAX_BYTES`: existing transfer limits.

There is no browser-origin allowlist because the Worker does not support a direct browser MCP client. No `AUTH_MODE`, `OAUTH_MASTER_KEY`, OAuth redirect allowlist, or D1 database variables are required.

## 6. Deploy

Production deployment is performed by the configured Cloudflare Build for this app. For a local dry run:

```bash
pnpm --filter ima-mcp-worker run deploy:dry-run
```

The Worker service remains:

```text
ima-mcp-worker
```

Current Worker endpoint shape:

```text
https://ima-mcp-worker.<workers-subdomain>.workers.dev/mcp
```

After every deployment, verify the deployed Worker still has:

- Secrets `CLIENT_ID`, `API_KEY`, `MCP_ACCESS_TOKEN`.
- R2 binding `R2_BUCKET` -> bucket `ima-mcp-worker`.
- Any separately required Durable Object binding for the image-refresh feature, if that feature is present.

## 7. Verify health and readiness

```bash
curl https://ima-mcp-worker.<workers-subdomain>.workers.dev/health
curl https://ima-mcp-worker.<workers-subdomain>.workers.dev/ready
```

`/health` is public liveness and does not access IMA.

A correctly configured `/ready` response is:

```json
{"ready":true}
```

If required configuration is missing, `/ready` returns HTTP 503 and only the missing capability names, never secret values.

## 8. Verify Portal authentication

A direct `/mcp` request without the bearer must be rejected:

```bash
curl -i -X POST https://ima-mcp-worker.<workers-subdomain>.workers.dev/mcp
```

Expected when `MCP_ACCESS_TOKEN` is configured: HTTP 401 with `WWW-Authenticate: Bearer`.

If `MCP_ACCESS_TOKEN` itself is missing from the Worker, `/mcp` fails closed with HTTP 503 instead of becoming public. A request carrying an `Origin` header is rejected with HTTP 403.

## 9. Configure Cloudflare MCP Portal

1. Add the Worker MCP endpoint as an MCP server.
2. Set upstream authentication type to **Bearer**.
3. Use the exact `MCP_ACCESS_TOKEN` value as the bearer credential.
4. Do not configure Worker-owned OAuth, Dynamic Client Registration, PKCE, or per-user IMA BYOK.
5. Add the server to the desired Portal.
6. Sync capabilities and verify that the expected IMA tools are visible.

Cloudflare Portal sends:

```text
Authorization: Bearer <MCP_ACCESS_TOKEN>
```

The shared Portal auth boundary consumes this header before MCP/domain handling. Client-facing authentication at Portal and this Worker access bearer are separate security layers.

## 10. R2 custom domain (optional)

In Cloudflare Dashboard -> R2 -> `ima-mcp-worker` -> Settings -> Custom Domains, attach a domain such as `download.example.com` and set:

```text
R2_CUSTOM_DOMAIN=https://download.example.com
```

Exports then return direct links beneath the existing `exports/...` object key structure. This existing download behavior is unchanged in the Portal ingress migration; signed/expiring download hardening is handled separately.

## 11. Local development

```bash
cp apps/ima-mcp-worker/.dev.vars.example apps/ima-mcp-worker/.dev.vars
pnpm --filter ima-mcp-worker run dev
```

Populate `CLIENT_ID`, `API_KEY`, and `MCP_ACCESS_TOKEN` before testing authenticated MCP requests.

No local D1 migration is required.

## 12. Naming

The GitHub app directory, Cloudflare Worker service, and production R2 bucket all use `ima-mcp-worker`.

## Large-file behavior

When the source URL returns `Content-Length`, the Worker streams it to COS using Cloudflare `FixedLengthStream`. When `Content-Length` is absent, it buffers only up to the configured bounded limit required for signing and upload. Existing file-size and SSRF protections remain unchanged.
