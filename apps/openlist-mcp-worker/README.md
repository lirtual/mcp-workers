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

Remaining 12 candidates from the 18-tool Spec are **not registered** pending confirmed driver conflict behavior, disposable E2E, authenticated client approval, scoped share concurrency safety, or finite-lived link verification. A narrow `openlist_share_get` read-only adapter now exists for **internal tests only**: it requests one explicit share ID, validates every referenced file path against allowed roots, and returns only allowlisted non-secret metadata. It is **not** published as an MCP tool; no global share list or share mutation was added. In particular, **do not infer from a configured admin token that physical storage is confined to these roots**. Even listed tools still require production read-only verification before launch.

Folder creation first checks a complete bounded parent listing for collisions, then verifies the created directory via a separate read. This is **not an atomic no-overwrite guarantee**. Missing preflight evidence prevents dispatch; post-dispatch uncertainty is never treated as a confirmed success or retried automatically. Mutations are non-atomic. UTF-8 file reads disallow redirects, require byte-for-byte agreement with upstream file metadata size, and are bound to supported text types and a 256 KiB maximum. Search reconstructs result paths from the upstream `parent` + `name` fields, never from unverified `path` or raw provider URLs. `get_file`, `read_text` and listing responses verify that any upstream name/path identity matches the explicitly requested file or immediate child before exposing metadata or content.

## Verification

`pnpm --filter openlist-mcp-worker check` runs typecheck, Wrangler dry run, Node contract tests and real workerd/Miniflare multi-Worker isolation tests. The Miniflare dependency is pinned and uses the compatibility adapter for its worker options. Real binding, portal discovery and disposable live tests are separate blocking gates. **No production deployment or automatic release is authorized by this code.**

## Required read-only verification on a separately authorized production release

A separately authorized first release uses the existing manual Workflow
`bootstrap` route when `openlist-mcp-worker` is absent. Before staging or
publishing, OpenList-only read-only Cloudflare inventory checks require the
**existing** `openlist-tsworkers` Service Binding target to be deployed.
Missing or incomplete upstream inventory stops the release; no new upstream
Worker is created, and no test changes any production resource.

The existing release-time `OPENLIST_ALLOWED_ROOTS` validation reuses the
Worker runtime canonical path parser, including Unicode normalization, reserved
segments and segment-length rules; invalid roots fail before Wrangler deploy.

The existing single-Worker manual release runs `scripts/openlist-production-read-smoke.mjs`
**after** Cloudflare version/Service Binding readback and anonymous MCP denial, but
**before** registering OpenList in One-MCP. It invokes only
`openlist_list_files` with a page size of one against **each configured**
allowed root through the actual authenticated MCP endpoint. It also requires
one out-of-scope path to return an explicit `OUT_OF_SCOPE` denial. A missing/invalid
upstream token, unusable Service Binding, inaccessible root, malformed or
unsuccessful MCP result blocks Portal registration. It does not log file
names, paths, credentials, raw responses or read file contents. Because the
check runs after deploy, it **cannot prevent the Worker code from being
published**; it fails release acceptance and blocks Portal onboarding.
This is not a substitute for real disposable driver-write acceptance, nor
does it authorize initial deployment.

## Portal registration after an authorized first release

The existing manual single-Worker GitHub Actions release registers this Worker into One-MCP only **after** Cloudflare deployment, exact version/binding readback, public-health check and an unauthenticated MCP rejection test. Registration checks the real server `tools/list` inventory against the six known tools and preserves all existing One-MCP Portal mappings. Any mismatch fails the release job; this step does **not** authorize deployment or enable auto-release.
