# Security

- Cloudflare MCP Portal / Managed OAuth is the target client-facing ingress.
- During the expand phase, the Worker also retains independent verification of the existing Cloudflare Access assertion JWT for rollback.
- Portal -> Worker traffic uses a dedicated `MCP_ORIGIN_TOKEN`; it is never reused as `OPENLIST_TOKEN`.
- A valid Portal bearer is consumed and removed before MCP/domain handling.
- A supplied invalid bearer is rejected; it does not silently fall back to Access JWT verification.
- Disable the public `workers.dev` endpoint; `wrangler.jsonc` already sets `workers_dev=false`.
- Use a dedicated low-privilege OpenList account/token where possible.
- Configure `OPENLIST_ALLOWED_PATHS` narrowly.
- Keep `OPENLIST_READONLY=true` until write access is intentionally needed.
- Never log `OPENLIST_TOKEN`, `MCP_ORIGIN_TOKEN`, Access assertions, client OAuth tokens, base64 upload bodies, or raw download URLs.
- `confirm=true` helps prevent accidental destructive calls but is not authorization.
- Removing Access JWT verification belongs only to the contract phase after live Portal acceptance succeeds.
