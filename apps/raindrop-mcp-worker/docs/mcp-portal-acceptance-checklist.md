# MCP Portal acceptance checklist

This checklist is the reusable acceptance contract for Portal-first remote MCP deployments in this workspace. Raindrop is the reference implementation; other MCP projects should preserve their own domain-specific authorization and safety controls while reusing these ingress checks.

## Trust boundaries

A Portal-first deployment has three distinct credential boundaries:

1. **Client identity** — handled by Cloudflare MCP Portal / Managed OAuth / Access.
2. **Worker origin identity** — a dedicated per-Worker `MCP_ACCESS_TOKEN` used only from Portal to the MCP Worker.
3. **Business API identity** — the credential the MCP Worker uses with its real upstream service.

Never reuse one credential across these boundaries. In particular, never forward the client OAuth bearer token to the business API and never store the business API credential in MCP Portal as the Worker origin credential.

## Pre-cutover checks

- [ ] The MCP Worker exposes a standards-based `/mcp` endpoint reachable on its `workers.dev` hostname.
- [ ] `workers_dev` is enabled.
- [ ] Preview URLs are disabled.
- [ ] No custom domain or zone route is required for MCP ingress.
- [ ] `/mcp` fails closed when `MCP_ACCESS_TOKEN` is missing or invalid.
- [ ] A valid `MCP_ACCESS_TOKEN` reaches the MCP transport.
- [ ] The Portal bearer is removed or isolated before domain tools/business logic can observe it.
- [ ] The business API credential is configured independently from `MCP_ACCESS_TOKEN`.
- [ ] Domain authorization, read-only mode, path allowlists, destructive-operation guards, and other service-specific safety controls remain enforced by the MCP Worker/upstream service.
- [ ] Logs and error responses do not expose client OAuth tokens, `MCP_ACCESS_TOKEN`, or business API credentials.

## Portal checks

- [ ] The upstream MCP server is registered in Cloudflare MCP Portal using the Worker's `workers.dev` `/mcp` URL.
- [ ] Portal upstream authentication uses the Worker's dedicated `MCP_ACCESS_TOKEN`, not the business API credential.
- [ ] Managed OAuth / Access policy permits only the intended user or account.
- [ ] The MCP client is configured with the **Portal URL**, not the raw Worker origin URL.
- [ ] Portal discovers the server successfully.
- [ ] Portal enumerates the expected tool surface.

## Functional smoke checks

Run these in order and stop on the first failure:

1. Confirm an unauthenticated direct `/mcp` request is rejected.
2. Confirm an authenticated direct `/mcp` request reaches the MCP transport.
3. Confirm Portal discovery succeeds.
4. Confirm the MCP client can enumerate tools through Portal.
5. Execute one representative **read-only** tool and verify the upstream result.
6. Do **not** exercise write/destructive tools against production user data as part of routine cutover smoke. Write-path behavior is verified by contract/safety tests; if a separate write verification is explicitly authorized, use disposable non-production data/resources and record cleanup.
7. Confirm destructive/read-only annotations and runtime safety controls still match the service contract.
8. Inspect application logs and confirm no secret values were emitted.

## Evidence requirement

Treat the checklist above as an operational gate, not as documentation-only acceptance. Record the date, deployed `workers.dev` origin, Portal name, representative read-only tool, and secret-redaction result in the migration ticket before declaring a service cut over. Code and CI can prove fail-closed behavior and credential separation, but they do not substitute for live Portal discovery and a safe read-only tool execution.

## Rollback requirement

Before production cutover, document how to restore the previous publisher without changing business-service state or rotating unrelated business credentials. Rollback should affect only the ingress/authentication layer unless a service-specific incident requires otherwise.

## Gateway exception rule

`cloudflare_gateway` is not part of the normal Portal-first path. Insert it only when a concrete Cloudflare MCP Portal capability gap has been demonstrated, such as a required path rewrite or body/response transformation that Portal cannot express. The exception must document the exact missing capability and must not collapse client, Worker-origin, and business credentials into one token.

## Raindrop reference result

Raindrop's expected reference path is:

```text
MCP client
  -> Cloudflare MCP Portal + Managed OAuth
  -> Authorization: Bearer <MCP_ACCESS_TOKEN>
  -> https://raindrop-mcp-worker.aiyaya.workers.dev/mcp
  -> RAINDROP_ACCESS_TOKEN
  -> Raindrop.io API
```

The detailed Raindrop deployment procedure remains in `docs/cloudflare-mcp-portal.md`.
