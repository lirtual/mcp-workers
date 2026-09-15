# Cloudflare MCP Portal deployment

IMA uses Cloudflare MCP Portal as the only supported client-facing ingress for this single-user deployment.

## Target architecture

```text
MCP client
  -> Cloudflare MCP Portal + Access
  -> Authorization: Bearer <MCP_ACCESS_TOKEN>
  -> ima-mcp-worker Worker /mcp
  -> Worker Secrets CLIENT_ID + API_KEY
  -> IMA OpenAPI

ima-mcp-worker Worker
  -> R2_BUCKET
  -> R2 bucket ima-mcp-worker
```

There is no Worker-owned OAuth provider and no D1 credential vault.

## Credential boundaries

Three identities are deliberately independent:

1. **Portal/client identity** — Cloudflare Access protects the Portal URL.
2. **Origin credential** — `MCP_ACCESS_TOKEN` authenticates Portal requests to the Worker.
3. **IMA business credential** — `CLIENT_ID` and `API_KEY` authenticate Worker requests to IMA OpenAPI.

Do not reuse any credential across these layers.

## Configure the Worker

Required Worker Secrets:

```text
CLIENT_ID
API_KEY
MCP_ACCESS_TOKEN
```

Required R2 binding:

```text
R2_BUCKET -> ima-mcp-worker
```

The old `IMA_OPENAPI_CLIENTID`, `IMA_OPENAPI_APIKEY`, `CLIENTID`, `APIKEY`, `AUTH_MODE`, `OAUTH_MASTER_KEY`, and D1 bindings are not supported by the new runtime.

## Add the Worker to MCP Portal

In Cloudflare Zero Trust > Access controls > MCP Portals:

1. Add the Worker's `/mcp` URL as an MCP server.
2. Set authentication type to **Bearer**.
3. Set the bearer credential to the same value as Worker Secret `MCP_ACCESS_TOKEN`.
4. Save the server and sync capabilities.
5. Add it to the desired Portal.
6. Protect the Portal URL with the desired Cloudflare Access policy.

For a bearer-authenticated upstream server, Cloudflare sends:

```text
Authorization: Bearer <MCP_ACCESS_TOKEN>
```

Do not configure Dynamic Client Registration, OAuth authorization endpoints, PKCE, refresh tokens, or per-user IMA BYOK for this Worker.

## Runtime behavior

### `/mcp`

- missing Worker-side `MCP_ACCESS_TOKEN`: HTTP 503 configuration failure;
- missing or incorrect request bearer: HTTP 401 with `WWW-Authenticate: Bearer`;
- valid bearer plus configured `CLIENT_ID` / `API_KEY`: proceeds to the normal MCP handler;
- old IMA secret names do not satisfy configuration.

### `/health`

Public liveness endpoint. It does not access D1 and does not expose secret values.

### `/ready`

Checks the required runtime capabilities:

- `MCP_ACCESS_TOKEN`;
- `CLIENT_ID`;
- `API_KEY`;
- `R2_BUCKET`;
- any required image-refresh Durable Object binding if that feature is present.

A failure lists only missing capability names.

## Acceptance checks

1. Direct raw `/mcp` without a bearer fails.
2. Portal capability sync succeeds.
3. Portal lists the expected IMA tools.
4. A representative read tool succeeds.
5. A representative safe write tool succeeds.
6. An export succeeds through `R2_BUCKET` and lands in the `ima-mcp-worker` bucket.
7. Logs do not contain `MCP_ACCESS_TOKEN`, `CLIENT_ID`, `API_KEY`, or client authentication tokens.

## Cloudflare reference

Cloudflare MCP server portals support upstream `bearer` authentication. A raw bearer credential is forwarded as the standard `Authorization: Bearer <token>` header. Portal Access authentication remains separate from upstream server authentication.

Official documentation: https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/
