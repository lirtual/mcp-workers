# OpenList MCP Worker · Spec #309

## Implementation status (2026-10-27)

OpenList MCP is implemented in `main` and its first six tools have been
deployed and exercised through a real ChatGPT client (see Issue #309 for
release and acceptance evidence). **This does not mean the entire 18-tool
candidate Spec has passed**. The other 12 tools remain unregistered until
their own upstream driver, authorization, client-confirmation and safety gates
pass. This Worker does not provide a general-purpose OpenList API proxy.

The existing disposable Koofr E2E folder and tiny synthetic file were
intentionally retained for human inspection. Cleanup remains outstanding
and requires separate authorization; never delete them as part of CI.
Automatic production publication is disabled while the trusted `main` branch
protection and all conditional release gates are not satisfied. Releases
must not be enabled merely because CI is green.


An independent, fail-closed MCP adapter to the existing OpenList-Worker using a Cloudflare **Service Binding**. This adapter does not change the upstream deployment, drivers, mounts, UI or public route.

## Configuration

- Service Binding `OPENLIST` → Cloudflare script `openlist-tsworkers`.
- Secret `MCP_ACCESS_TOKEN` → incoming Portal credential, separate from upstream.
- Secret `OPENLIST_API_TOKEN` → upstream static admin-equivalent token (do not reuse incoming token).
- Plain variable `OPENLIST_ALLOWED_ROOTS` → JSON array of canonical non-root virtual paths, e.g. `["/Koofr/mcp-test"]`. Configure explicitly at deploy time; absence fails closed.

No public OpenList base URL, separate database, Cron, or generic HTTP proxy.

## Upstream KV deployment safety

The upstream `openlist-tsworkers` is a separate, existing production Worker.
Its KV binding is **not** managed by the MCP adapter. As verified in October
2026, both the official `OpenListTeam/OpenList-Worker` and the exact-sync
read-only Fork `lirtual/OpenList-Worker` leave the example
`kv_namespaces` setting **commented out** in `wrangler.jsonc`. A Wrangler
deployment using that effective config can remove an existing production
KV binding even though the KV namespace itself still exists.

Do **not** deploy the upstream with an unchecked configuration or assume a
dashboard binding survives a Wrangler upload. Preserve the **existing** `KV`
namespace, `openlist-tsworkers-kv` (`298dbc9310f948c796522911d0405379`);
never create a replacement empty namespace as an automatic recovery step.
Any upstream publishing changes require separate authorization and an
upstream-approved configuration strategy; this project must not modify or
privately patch its Fork.

The manual OpenList MCP release checks the active Cloudflare Worker version,
existing `KV` namespace identity, `DB_DRIVER=auto`, and public storage status
immediately before Wrangler publication. Production functionality is verified
directly through the existing ChatGPT OpenList MCP; no scheduled acceptance
or automatic storage repair is configured.

## Exposed tools

`openlist_capabilities`, `openlist_list_files`, `openlist_get_file`,
`openlist_search_files`, `openlist_read_text`, `openlist_create_folder`.

Remaining 12 candidates from the 18-tool Spec are **not registered** pending confirmed driver conflict behavior, disposable E2E, authenticated client approval, scoped share concurrency safety, or finite-lived link verification. A narrow `openlist_share_get` read-only adapter now exists for **internal tests only**: it requests one explicit share ID, validates every referenced file path against allowed roots, and returns only allowlisted non-secret metadata. It is **not** published as an MCP tool; no global share list or share mutation was added. In particular, **do not infer from a configured admin token that physical storage is confined to these roots**. Any subsequent release still requires the applicable independent production checks.

Folder creation first checks a complete bounded parent listing for collisions, then verifies the created directory via a separate read. This is **not an atomic no-overwrite guarantee**. Missing preflight evidence prevents dispatch; post-dispatch uncertainty is never treated as a confirmed success or retried automatically. Mutations are non-atomic. UTF-8 file reads disallow redirects, require byte-for-byte agreement with upstream file metadata size, and are bound to supported text types and a 256 KiB maximum. Search reconstructs result paths from the upstream `parent` + `name` fields, never from unverified `path` or raw provider URLs. Pagination returns `total` (the **unfiltered upstream** count), `page`, `per_page`, and `has_more` (based on upstream total); after path/scope filtering, `entries.length` may be smaller than the upstream count. `get_file`, `read_text` and listing responses verify that any upstream name/path identity matches the explicitly requested file or immediate child before exposing metadata or content.

## P1 write candidates: upstream overwrite gate (2026-10-27)

The scoped Koofr acceptance mount was reported by the real upstream as a
WebDAV provider, and the connected ChatGPT OpenList client still confirms
only the six existing tools are enabled. The retained disposable fixture is
present; **no collision or mutation test was run during this audit**.

In OpenList-Worker upstream source at
[`29b7a8eb`](https://github.com/OpenListTeam/OpenList-Worker/tree/29b7a8eb687aa5daf6cd2158fa27d83232ebae6f),
the [WebDAV driver](https://github.com/OpenListTeam/OpenList-Worker/blob/29b7a8eb687aa5daf6cd2158fa27d83232ebae6f/src/backend/drivers/webdav/driver.ts)
calls MOVE/COPY with `overwrite=true` for rename, move, and copy; the
[WebDAV client](https://github.com/OpenListTeam/OpenList-Worker/blob/29b7a8eb687aa5daf6cd2158fa27d83232ebae6f/src/backend/drivers/webdav/util.ts)
sends `Overwrite: T` by default. Its PUT lacks an `If-None-Match: *`
condition. The fixed
[upstream file routes](https://github.com/OpenListTeam/OpenList-Worker/blob/29b7a8eb687aa5daf6cd2158fa27d83232ebae6f/src/backend/server/fs.ts)
do not provide a no-overwrite input for these four operations. A separate
`list/get` preflight would remain racy, and a successful prior fixture upload
does not establish safe conflict behavior. This source audit is not evidence
that every deployed driver revision or Koofr backend honors a proposed
conditional request.

**Decision:** keep `openlist_upload_small`, `openlist_rename`,
`openlist_copy`, and `openlist_move` unregistered. To reconsider them,
first obtain a verified driver-enforced no-overwrite contract (including
real Koofr collision and concurrency tests and appropriate conditional
semantics) or explicitly revise Spec #309's trusted-human-overwrite policy.
Retain scope, single-target, cross-storage, uncertain-dispatch and no-retry
gates. Do not add a proxy, database or broad REST escape hatch to bypass this
restriction. The contract test also checks that direct invocation of these
unregistered tools does not dispatch a Service Binding request.

## Verification

`pnpm --filter openlist-mcp-worker check` runs typecheck, Wrangler dry run, Node contract tests and real workerd/Miniflare multi-Worker isolation tests. The Miniflare dependency is pinned and uses the compatibility adapter for its worker options. Real binding, portal discovery and disposable live tests are separate blocking gates. **Code and CI success do not independently authorize another production deployment or automatic release.**

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
names, paths, credentials, raw responses or read file contents. It also
verifies every returned item against a safe metadata allowlist, rejecting
exposed `raw_url`, `sign`, passwords, forged paths and malformed fields. Because the
check runs after deploy, it **cannot prevent the Worker code from being
published**; it fails release acceptance and blocks Portal onboarding.
This is not a substitute for real disposable driver-write acceptance, nor
does it authorize initial deployment.

## Portal registration after an authorized first release

The existing manual selected-Worker release now defaults `openlist_portal_registration=false`. A first, separately approved publication may deploy the Worker and run read-only/scope verification **without** registering it into One-MCP. Only after the real disposable-driver E2E (including file metadata/search/text and controlled folder creation) is recorded and explicitly accepted may a **separate manual** release set `openlist_portal_registration=true`. This flag is an operator approval, not proof supplied by CI; do not set it on the first publication before actual E2E evidence. Registration still follows exact Cloudflare version/binding readback, public health, anonymous rejection and production read-only checks; it validates the six-tool `tools/list` inventory and preserves all existing Portal mappings. The added input neither authorizes deployment by itself nor enables automatic releases.

## Failure state and controlled recovery

A manual release is **not atomic across Cloudflare Worker deployment and One-MCP
Portal registration**. GitHub Actions marks a failed post-deploy verification
as **failed**, but the newly published Worker may still be running. Do not
describe this as a successful launch or assume automatic rollback. In
particular:

- If version, binding, health, anonymous-denial or authenticated read/scope/
  metadata verification fails, **Portal registration has not yet started** in
  that run. Keep this incident blocked and inspect the active Worker version,
  binding, logs and approved configuration through read-only access.
- If Portal registration itself fails, it may already have created an
  unattached `openlist` server or updated Portal mappings before its final
  readback. Inspect both server inventory and the `one-mcp` mapping. Do not
  assume the server was removed, retry blindly or delete existing mappings.
- After correcting the specific failure, require a fresh, explicit authorized
  manual selected-Worker release from trusted `main`. Repeat all post-deploy
  checks; a previous partial release and green CI are not production
  acceptance. Never auto-roll back, auto-enable candidate tools or enable
  automatic publishing to recover.


## Disposable real-driver E2E (independent of Worker release)

The manual `OpenList Driver Acceptance` GitHub Actions workflow verifies the
existing deployed Worker; it does **not** publish or configure a Worker, change
One-MCP, or enable any unregistered tools. It only runs from the current
`main` with `confirm_disposable_write=true` and environment
`openlist-mcp-worker` using existing scoped credentials.

Acceptance is constrained to the exact single configured
`/Koofr/Downloads` root. Its bounded first-page listing must be complete
(`total === entries.length <= 100`) and contain **only directories named
`mcp-spec309-e2e-<run-id>-<attempt>` from previous disposable runs**;
ordinary user files, other directories, malformed entries, duplicates,
missing pages and a reused current run name all stop *before writing*.
Retained artifacts are never read, modified or deleted. Each separately
authorized execution creates a fresh unique subfolder through the **deployed**
`openlist_create_folder` tool, verifies its metadata and emptiness, then
creates **one** small synthetic text file through the reviewed
upstream `/api/fs/put` endpoint using the separately scoped admin-equivalent
environment Secret. This upstream upload is only disposable test data setup:
it is **not** evidence that the gated public `openlist_upload_small` MCP
tool works or is safe. There are no overwrite claims or effectful retries.

The script then uses MCP tools to verify file metadata, list, search, exact
UTF-8 text retrieval and out-of-scope **write** refusal. Logs include only
stable result/error codes and synthetic run-specific folder names; no
tokens, upstream response bodies or actual file content are logged. Failed
or uncertain writes are not retried. The test leaves the tiny synthetic
file and folder for explicit review and *manual* cleanup rather than using
an unaccepted destructive API.

A passing workflow establishes driver E2E evidence only. Independent
approval and ChatGPT Portal acceptance are still required before linking the
Worker to One-MCP; a green acceptance run does not automatically release,
register, enable gated tools or close Issue #309.
