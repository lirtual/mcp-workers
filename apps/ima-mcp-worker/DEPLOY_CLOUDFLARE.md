# Cloudflare deployment

This project uses one production architecture: Cloudflare MCP Portal in front of the `ima-mcp-worker` Worker, a static per-Worker bearer credential, Worker Secrets for IMA credentials, and R2 for exported files. Export downloads use the R2 bucket's public custom domain directly; D1, Worker-owned OAuth, download signing, and a Worker download proxy are not used.

## 1. Requirements

- Cloudflare account
- Node.js 24 + pnpm 10
- Wrangler login or equivalent Cloudflare Dashboard access
- IMA OpenAPI Client ID and API Key
- Cloudflare MCP Portal
- A Cloudflare-managed DNS zone for the R2 custom domain

## 2. Install dependencies

From the monorepo root:

```bash
pnpm install --frozen-lockfile
```

## 3. Create or reuse the R2 bucket

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

If the bucket already exists, do not recreate it.

Exports use the `exports/` prefix and a generated UUID per export. If automatic cleanup is desired, configure an R2 Object Lifecycle Rule for the `exports/` prefix. No Cron or Queue cleanup worker is required.

## 4. Connect the R2 custom domain

For the current deployment, connect:

```text
temp.lirtual.dpdns.org
```

In Cloudflare Dashboard:

1. Open **R2 Object Storage**.
2. Select bucket **`ima-mcp-worker`**.
3. Open **Settings → Custom Domains**.
4. Select **Add / Connect Domain**.
5. Enter **`temp.lirtual.dpdns.org`**.
6. Review the DNS record Cloudflare will create and confirm the connection.
7. Wait until ownership and SSL status are active.

The domain must belong to a Cloudflare zone in the same account as the R2 bucket.

For production, disable the bucket's public `r2.dev` development URL so there is only one intended public download origin.

## 5. Configure Worker Secrets

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

Do not reuse any one credential for another role, and do not reuse this Worker's access token for another Worker.

Retired names are not supported: `IMA_OPENAPI_CLIENTID`, `IMA_OPENAPI_APIKEY`, `CLIENTID`, `APIKEY`, and `IMA_DOWNLOAD_SIGNING_KEY`.

## 6. Configure the non-secret R2 public origin

`R2_PUBLIC_BASE_URL` is a normal Worker runtime variable, not a secret and not a hard-coded repository value.

In **Workers & Pages → ima-mcp-worker → Settings → Variables and Secrets**, add a normal variable:

```text
R2_PUBLIC_BASE_URL=https://temp.lirtual.dpdns.org
```

The value must be an HTTPS origin with no path, query, fragment, or embedded credentials.

`wrangler.jsonc` intentionally does not contain the value. It sets:

```json
{
  "keep_vars": true
}
```

so Dashboard-managed normal variables are preserved on future `wrangler deploy` operations.

Other optional variables include `IMA_BASE_URL`, `FILE_DOWNLOAD_TIMEOUT_MS`, `FILE_DOWNLOAD_MAX_REDIRECTS`, `FILE_DOWNLOAD_MAX_BUFFER_BYTES`, and `IMA_RESPONSE_MAX_BYTES`.

There is no browser-origin allowlist because the Worker does not support a direct browser MCP client. No `AUTH_MODE`, `OAUTH_MASTER_KEY`, OAuth redirect allowlist, D1 variables, `PUBLIC_BASE_URL`, `IMA_DOWNLOAD_TTL_SECONDS`, or `IMA_EXPORT_RETENTION_SECONDS` are required.

## 7. Deploy

Production deployment is performed by the configured Cloudflare Build for this app. For a local dry run:

```bash
pnpm --filter ima-mcp-worker run deploy:dry-run
```

The Worker service remains:

```text
ima-mcp-worker
```

Current MCP endpoint shape:

```text
https://ima-mcp-worker.<workers-subdomain>.workers.dev/mcp
```

After every deployment, verify the deployed Worker still has:

- Secrets `CLIENT_ID`, `API_KEY`, and `MCP_ACCESS_TOKEN`.
- R2 binding `R2_BUCKET` -> bucket `ima-mcp-worker`.
- Runtime variable `R2_PUBLIC_BASE_URL` set to the active R2 custom-domain origin.
- Active R2 custom domain `temp.lirtual.dpdns.org` for the current deployment.
- Public `r2.dev` development URL disabled for production.
- Any separately required Durable Object binding for the image-refresh feature, if that feature is present.

## 8. Verify health and readiness

```bash
curl https://ima-mcp-worker.<workers-subdomain>.workers.dev/health
curl https://ima-mcp-worker.<workers-subdomain>.workers.dev/ready
```

`/health` is public liveness and does not access IMA.

A correctly configured `/ready` response is:

```json
{"ready":true}
```

If required configuration is missing, `/ready` returns HTTP 503 and only the missing capability names, never secret values. `R2_PUBLIC_BASE_URL` is part of readiness because exported files must resolve to the configured R2 custom domain.

## 9. Verify Portal authentication

A direct `/mcp` request without the bearer must be rejected:

```bash
curl -i -X POST https://ima-mcp-worker.<workers-subdomain>.workers.dev/mcp
```

Expected when `MCP_ACCESS_TOKEN` is configured: HTTP 401 with `WWW-Authenticate: Bearer`.

If `MCP_ACCESS_TOKEN` itself is missing from the Worker, `/mcp` fails closed with HTTP 503 instead of becoming public. A request carrying an `Origin` header is rejected with HTTP 403.

## 10. Configure Cloudflare MCP Portal

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

## 11. Verify direct R2 downloads

Generate an export through the normal authenticated MCP path. The returned URL should point directly at the configured R2 public origin:

```text
<R2_PUBLIC_BASE_URL>/exports/<type>/<id>/<export-uuid>/<filename>
```

For the current deployment that resolves to:

```text
https://temp.lirtual.dpdns.org/exports/<type>/<id>/<export-uuid>/<filename>
```

Acceptance checks:

1. The returned URL downloads the expected object without going through `ima-mcp-worker`.
2. The URL has no `sig`, `expires`, `MCP_ACCESS_TOKEN`, IMA API credential, or other secret query parameter.
3. The Worker returns `404` for `/download/*`; no download relay exists.
4. Re-exporting the same note/media creates a different R2 key because each export includes a generated UUID.
5. Unicode and reserved filename characters are percent-encoded in the URL path while the underlying R2 object key is preserved.
6. If a lifecycle rule deletes the object, the public URL naturally returns not found from R2.

The R2 custom domain is public object access. The random UUID makes object URLs difficult to guess but is not an authorization mechanism.

## 12. Local development

```bash
cp apps/ima-mcp-worker/.dev.vars.example apps/ima-mcp-worker/.dev.vars
pnpm --filter ima-mcp-worker run dev
```

Populate `CLIENT_ID`, `API_KEY`, and `MCP_ACCESS_TOKEN` for local authentication. Configure `R2_PUBLIC_BASE_URL` separately when testing export URL generation.

No local D1 migration is required.

## 13. Naming

- GitHub app directory: `apps/ima-mcp-worker`
- Cloudflare Worker service: `ima-mcp-worker`
- R2 bucket: `ima-mcp-worker`
- R2 custom-domain origin: runtime-configured through `R2_PUBLIC_BASE_URL`

## Large-file behavior

When the source URL returns `Content-Length`, the Worker streams it to COS using Cloudflare `FixedLengthStream`. When `Content-Length` is absent, it buffers only up to the configured bounded limit required for signing and upload. Existing file-size and SSRF protections remain unchanged.
