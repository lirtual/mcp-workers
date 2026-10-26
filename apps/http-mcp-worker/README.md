# HTTP MCP Worker (Spec #303)

Stateless Streamable HTTP MCP Worker that offers one tool, `http_request`, for interactive debugging of public HTTP(S) APIs. It uses the existing Portal bearer authorization. Routes: public GET /health and authenticated /mcp only.

## Calls and security

Seven methods: GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS. The latter methods can modify upstream systems. Caller/client approval is **not** a Worker-enforced per-write authorization. Untrusted endpoint responses never authorize more tool calls. There are no retries or persistent request histories.

Accept exactly one of `json` (explicit null included), `form` or `text`; GET/HEAD cannot carry bodies. Request max 1 MiB, response default 256 KiB (max 1 MiB), timeout default 15 seconds (max 30), redirects default manual, optional same-origin follow only for GET/HEAD (up to five hops). Return real 3xx/4xx/5xx statuses as HTTP data. Transport problems on potentially effectful methods return `indeterminate` because upstream effects may have completed.

URL parser rejects IP literals, userinfo, local/internal hostnames and malformed URLs; `global_fetch_strictly_public` is required and there are no VPC/service bindings. This is not a claim of complete DNS/SSRF isolation. Public custom HTTP(S) ports are allowed by app policy, but Cloudflare proxies may not actually route to the requested custom port.

The optional `HTTP_CREDENTIALS_JSON` Secret holds at most 16 static rules, 5,120 UTF-8 bytes total:

```json
[{"origin":"https://api.example.org","pathPrefix":"/v1","headers":{"X-API-Key":"SYNTHETIC-NOT-A-KEY"}}]
```

Rules require exact canonical HTTPS origin (including effective port) and path-segment prefix with no overlaps/wildcards. Malformed rules fail closed. Caller Header collision with managed Header fails. Known temporary auth Headers cannot be used over HTTP. Body/query fields might themselves carry secrets and are not automatically recognized. Redaction of known Header values is best-effort; encoding/transforms and arbitrary business content can still leak. Log only request ID, method, hostname, status, bytes and duration. Cloudflare and targets may independently log.

Full result is in MCP `structuredContent`; text-only clients receive a short metadata summary to avoid copying large response bodies twice. Compatibility of this presentation must be verified in real ChatGPT acceptance.

## Verification and release

Run `pnpm install --frozen-lockfile` then `pnpm --filter http-mcp-worker check`. The tests exercise actual authenticated MCP tools/list and tools/call with a controlled outbound fetch. They do not establish real Cloudflare routing or Portal/ChatGPT acceptance.

CI and existing manual main-only release allowlist recognize this Worker. GitHub Environment `http-mcp-worker` needs `MCP_ACCESS_TOKEN`, and may supply `HTTP_CREDENTIALS_JSON`. Never set an empty placeholder for the optional Secret. Cloudflare preserves Secrets omitted from Wrangler `--secrets-file`; if GitHub removes the optional Secret but an old runtime binding remains, the release preflight blocks until the binding is separately removed under operational authorization.

No production publish/Portal registration is part of this source implementation. First production release and safe, non-destructive real acceptance need separate authorization. Never use a user's destructive production business API for release smoke tests.
