# Cloudflare deployment

This project uses one production architecture: Cloudflare MCP Portal in front of the `ima-mcp-worker` Worker, a static per-Worker bearer credential, Worker Secrets for IMA credentials, an independent download-signing secret, and R2 for temporary exports. D1 and Worker-owned OAuth are not used.

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

Protected temporary exports use the `exports/` prefix. Configure an R2 Object Lifecycle Rule on the `ima-mcp-worker` bucket to delete `exports/` objects after 7 days (or the configured retention period). Object lifecycle is bucket-level Cloudflare configuration rather than a Worker binding field.

After configuration, verify the rule:

```bash
pnpm --filter ima-mcp-worker exec wrangler r2 bucket lifecycle list ima-mcp-worker
```

Do not expose protected `exports/` objects through an R2 public/custom-domain route. Downloads are served only through the Worker signature-verification route.

## 4. Configure Worker Secrets

Required secrets:

```bash
pnpm --filter ima-mcp-worker exec wrangler secret put CLIENT_ID
pnpm --filter ima-mcp-worker exec wrangler secret put API_KEY
pnpm --filter ima-mcp-worker exec wrangler secret put MCP_ACCESS_TOKEN
pnpm --filter ima-mcp-worker exec wrangler secret put IMA_DOWNLOAD_SIGNING_KEY
```

The same values can be entered in Cloudflare Dashboard under the Worker's Variables and Secrets settings.

Credential roles are intentionally separate:

- `CLIENT_ID`: IMA OpenAPI Client ID.
- `API_KEY`: IMA OpenAPI API Key.
- `MCP_ACCESS_TOKEN`: independent Portal-to-Worker bearer token for this Worker.
- `IMA_DOWNLOAD_SIGNING_KEY`: independent high-entropy HMAC key used only for temporary export URLs.

Do not reuse any one credential for another role, and do not reuse this Worker's access token for another Worker. In particular, `MCP_ACCESS_TOKEN` must never be embedded in a download URL.

Retired names are not supported: `IMA_OPENAPI_CLIENTID`, `IMA_OPENAPI_APIKEY`, `CLIENTID`, and `APIKEY`.

## 5. Optional/non-secret variables

- `IMA_BASE_URL`: overrides the default `https://ima.qq.com` endpoint.
- `PUBLIC_BASE_URL`: optional canonical Worker/custom-host origin used for generated download links. During MCP requests, the current Worker origin is used when this is omitted.
- `IMA_DOWNLOAD_TTL_SECONDS`: temporary-link lifetime; default `3600` seconds.
- `IMA_EXPORT_RETENTION_SECONDS`: intended R2 object retention; default `604800` seconds and must be at least the link TTL. The R2 lifecycle rule must match this operational setting.
- `FILE_DOWNLOAD_TIMEOUT_MS`, `FILE_DOWNLOAD_MAX_REDIRECTS`, `FILE_DOWNLOAD_MAX_BUFFER_BYTES`, `IMA_RESPONSE_MAX_BYTES`: existing transfer limits.

`R2_CUSTOM_DOMAIN` is no longer a supported export path because a public object URL would bypass Worker signature verification.

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

- Secrets `CLIENT_ID`, `API_KEY`, `MCP_ACCESS_TOKEN`, `IMA_DOWNLOAD_SIGNING_KEY`.
- R2 binding `R2_BUCKET` -> bucket `ima-mcp-worker`.
- An R2 lifecycle rule that removes `exports/` objects after the intended retention period.
- No public/custom-domain path that exposes protected export objects without Worker verification.
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

If required configuration is missing, `/ready` returns HTTP 503 and only the missing capability names, never secret values. `IMA_DOWNLOAD_SIGNING_KEY` is part of readiness because export links must fail closed when signing is unavailable.

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

## 10. Verify temporary downloads

Generate an export through the normal authenticated MCP path. The returned URL should use the Worker route and contain `expires` and `sig` query parameters:

```text
https://ima-mcp-worker.<workers-subdomain>.workers.dev/download/<encoded-object-key>?expires=...&sig=...
```

Acceptance checks:

1. The unmodified URL downloads the expected object without requiring MCP authentication.
2. Removing `sig`, changing the object key, or changing `expires` returns HTTP 403.
3. An expired correctly signed URL returns HTTP 410.
4. A valid link whose R2 object has already been deleted returns HTTP 404.
5. Successful download responses use `Cache-Control: private, no-store`.
6. Re-exporting the same note/media creates a different R2 key because each export includes a generated UUID.
7. The returned URL never contains `MCP_ACCESS_TOKEN`, IMA API credentials, or the signing key.

The download-signing key is not an alternative MCP ingress token and is never accepted by `/mcp`.

## 11. Local development

```bash
cp apps/ima-mcp-worker/.dev.vars.example apps/ima-mcp-worker/.dev.vars
pnpm --filter ima-mcp-worker run dev
```

Populate `CLIENT_ID`, `API_KEY`, `MCP_ACCESS_TOKEN`, and `IMA_DOWNLOAD_SIGNING_KEY` before testing the complete runtime contract.

No local D1 migration is required.

## 12. Naming

The GitHub app directory, Cloudflare Worker service, and production R2 bucket all use `ima-mcp-worker`.

## Large-file behavior

When the source URL returns `Content-Length`, the Worker streams it to COS using Cloudflare `FixedLengthStream`. When `Content-Length` is absent, it buffers only up to the configured bounded limit required for signing and upload. Existing file-size and SSRF protections remain unchanged.
