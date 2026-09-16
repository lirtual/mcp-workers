# Security

- Cloudflare MCP Portal / Managed OAuth is the target client-facing ingress.
- Portal -> Worker traffic uses the Worker's dedicated `MCP_ACCESS_TOKEN`; it is never reused as `OPENLIST_TOKEN`.
- The Portal bearer is validated at the Worker boundary, consumed, and removed before MCP/domain handling.
- Missing or invalid `MCP_ACCESS_TOKEN` fails closed. The retired Cloudflare Access assertion / JWT path is not an authentication fallback.
- The Worker is exposed through its `workers.dev` hostname with `workers_dev:true` and `preview_urls:false`; no custom domain or zone route is required for target MCP ingress.
- Use a dedicated low-privilege OpenList account/token where possible.
- Configure `OPENLIST_ALLOWED_PATHS` narrowly.
- Keep `OPENLIST_READONLY=true` until write access is intentionally needed.
- Never log `OPENLIST_TOKEN`, `MCP_ACCESS_TOKEN`, client OAuth tokens, base64 upload bodies, or raw download URLs.
- `confirm=true` helps prevent accidental destructive calls but is not authorization.
- OpenList business authorization and path/read-only controls remain application-local; Portal authentication does not replace them.
