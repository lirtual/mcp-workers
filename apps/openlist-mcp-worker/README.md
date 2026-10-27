# OpenList MCP Worker · Spec #309

An independent, fail-closed MCP adapter to the existing OpenList-Worker using a Cloudflare **Service Binding**. This adapter does not change the upstream deployment, drivers, mounts, UI or public route.

## Configuration

- Service Binding `OPENLIST` → Cloudflare script `openlist-tsworkers`.
- Secret `MCP_ACCESS_TOKEN` → incoming Portal credential, separate from upstream.
- Secret `OPENLIST_API_TOKEN` → upstream static admin-equivalent token (do not reuse incoming token).
- Plain variable `OPENLIST_ALLOWED_ROOTS` → JSON array of canonical non-root virtual paths, e.g. `["/Koofr/mcp-test"]`. Configure explicitly at deploy time; absence fails closed.

No public OpenList base URL, separate database, Cron, or generic HTTP proxy.

## Exposed tools

`openlist_capabilities`, `openlist_list_files`, `openlist_get_file`,
`openlist_search_files`, `openlist_read_text`, `openlist_create_folder`.

Remaining 12 candidates from the 18-tool Spec are **not registered** pending confirmed driver conflict behavior, disposable E2E, authenticated client approval, scoped share concurrency safety, or finite-lived link verification. In particular, **do not infer from a configured admin token that physical storage is confined to these roots**. Even listed tools still require production read-only verification before launch.

Folder creation first checks a complete bounded parent listing for collisions, then verifies the created directory via a separate read. This is **not an atomic no-overwrite guarantee**. Missing preflight evidence prevents dispatch; post-dispatch uncertainty is never treated as a confirmed success or retried automatically. Mutations are non-atomic. UTF-8 file reads disallow redirects, require byte-for-byte agreement with upstream file metadata size, and are bound to supported text types and a 256 KiB maximum. Search reconstructs result paths from the upstream `parent` + `name` fields, never from unverified `path` or raw provider URLs.

## Verification

`pnpm --filter openlist-mcp-worker check` runs typecheck, Wrangler dry run, Node contract tests and real workerd/Miniflare multi-Worker isolation tests. The Miniflare dependency is pinned and uses the compatibility adapter for its worker options. Real binding, portal discovery and disposable live tests are separate blocking gates. **No production deployment or automatic release is authorized by this code.**

## Portal registration after an authorized first release

The existing manual single-Worker GitHub Actions release registers this Worker into One-MCP only **after** Cloudflare deployment, exact version/binding readback, public-health check and an unauthenticated MCP rejection test. Registration checks the real server `tools/list` inventory against the six known tools and preserves all existing One-MCP Portal mappings. Any mismatch fails the release job; this step does **not** authorize deployment or enable auto-release.
