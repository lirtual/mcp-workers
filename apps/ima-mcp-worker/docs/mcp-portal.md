# Cloudflare MCP Portal deployment

IMA uses Cloudflare MCP Portal as the only supported client-facing ingress for this single-user deployment.

## Target architecture

```text
MCP client
  -> Cloudflare MCP Portal
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

The identities are deliberately independent:

1. **Client-facing identity** — Cloudflare MCP Portal owns client authentication.
2. **Worker access credential** — this Worker's `MCP_ACCESS_TOKEN` authenticates Portal-to-Worker requests.
3. **IMA business credential** — `CLIENT_ID` and `API_KEY` authenticate Worker requests to IMA OpenAPI.

Do not reuse any credential across these layers or between Workers.

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

The old `IMA_OPENAPI_CLIENTID`, `IMA_OPENAPI_APIKEY`, `CLIENTID`, `APIKEY`, `AUTH_MODE`, `OAUTH_MASTER_KEY`, and D1 bindings are not supported by the runtime.

## Add the Worker to MCP Portal

1. Add the Worker's `/mcp` URL as an MCP server.
2. Set upstream authentication type to **Bearer**.
3. Set the bearer credential to the same value as Worker Secret `MCP_ACCESS_TOKEN`.
4. Save the server and sync capabilities.
5. Add it to the desired Portal.

For the upstream server, Portal sends:

```text
Authorization: Bearer <MCP_ACCESS_TOKEN>
```

Do not configure Worker-owned Dynamic Client Registration, OAuth authorization endpoints, PKCE, refresh tokens, or per-user IMA BYOK for this Worker.

## Runtime behavior

### `/mcp`

- missing Worker-side `MCP_ACCESS_TOKEN`: HTTP 503;
- missing or incorrect request bearer: HTTP 401 with `WWW-Authenticate: Bearer`;
- request carrying an `Origin` header: HTTP 403, because there is no direct browser client;
- valid bearer plus configured `CLIENT_ID` / `API_KEY`: proceeds to the normal MCP handler;
- old IMA secret names do not satisfy configuration.

The shared `@mcp-workers/portal-auth` boundary removes the inbound `Authorization` header before the request reaches the MCP SDK or IMA tools. Requests without an `Origin` header remain valid for server-to-server Portal traffic.

### `/health`

Public liveness endpoint. It does not access IMA or expose secret values.

### `/ready`

Checks the required runtime capabilities:

- `MCP_ACCESS_TOKEN`;
- `CLIENT_ID`;
- `API_KEY`;
- `R2_BUCKET`;
- any required image-refresh Durable Object binding if that feature is present.

A failure lists only missing capability names.

### `/download/*`

The existing R2 download behavior is unchanged by this ingress ticket. Signed/expiring download hardening is handled separately by the dedicated download-security ticket.

## Acceptance checks

1. Direct raw `/mcp` without a bearer fails with 401.
2. `/mcp` carrying a browser `Origin` fails with 403.
3. Portal capability sync succeeds.
4. Portal lists the expected IMA tools.
5. A representative read tool succeeds.
6. A representative safe write tool succeeds.
7. An export succeeds through `R2_BUCKET` and lands in the `ima-mcp-worker` bucket.
8. Logs do not contain `MCP_ACCESS_TOKEN`, `CLIENT_ID`, `API_KEY`, or client authentication tokens.

## Cloudflare reference

Cloudflare MCP server portals support upstream bearer authentication. Portal client authentication remains separate from the Worker access credential.

Official documentation: https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/
