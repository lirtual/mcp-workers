# OpenList MCP Worker · Spec #309

## Implementation status (2026-10-27)

Nine tools are registered on this Draft branch: the seven previously deployed
operations plus `openlist_share_disable` and `openlist_download_link` using the existing OpenList REST
endpoint. **Production continues to expose seven tools** until separately
authorized merge, manual release and real acceptance. The original
read-only explicit-ID `openlist_share_get` passed real production
acceptance after the controlled share test recorded in
[Issue #309](https://github.com/lirtual/mcp-workers/issues/309).
The one-time `openlist_share_create` used for that test was **retired from
the Worker, Portal inventory, and manual acceptance entrypoint** after
successful controlled production testing ([PR #369](https://github.com/lirtual/mcp-workers/pull/369)).
It must not be callable in future releases. The other nine candidates
remain unregistered and gated on this Draft branch; this adapter is not a general-purpose OpenList
API proxy. Verify the deployed inventory separately from this source document.

The original Koofr disposable E2E folders, synthetic test file, and expired
share metadata were **not deleted** by this code-only cleanup. Those require
separate authorization. Automatic production publication remains disabled;
only the existing manually authorized GitHub Actions production release is used.

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
`openlist_search_files`, `openlist_read_text`, `openlist_share_get`,
`openlist_download_link`, `openlist_share_disable`, `openlist_create_folder` (**nine registered tools on this Draft; seven deployed**).

`openlist_share_get` accepts one explicit ID and requires **every** file
in the share to remain within allowed roots before returning only allowlisted,
non-secret metadata. It never enumerates all shares, creates a share, exposes
a password/raw download link, or mutates a share. Both its direct production
lookup of the controlled synthetic share and the no-secret response contract
were verified in [#40507586080](https://github.com/lirtual/mcp-workers/actions/runs/40507586080).

`openlist_share_create` was enabled only temporarily to create one preapproved
50-byte synthetic share with a random hidden password, one-hour expiration
and one access. The live create/get proof succeeded; the tool and temporary
acceptance code have since been removed. The previously created share record
may remain expired upstream, but cleanup is out of scope. The nine remaining
candidates stay disabled on this Draft branch pending real driver/conflict, scope, approval, and
share-lifecycle safety evidence. Do not infer physical storage confinement from
the admin-equivalent upstream token. Every future production release requires
its own authorized checks.

Folder creation first checks a complete bounded parent listing for collisions, then verifies the created directory via a separate read. This is **not an atomic no-overwrite guarantee**. Missing preflight evidence prevents dispatch; post-dispatch uncertainty is never treated as a confirmed success or retried automatically. Mutations are non-atomic. UTF-8 file reads disallow redirects, require byte-for-byte agreement with upstream file metadata size, and are bound to supported text types and a 256 KiB maximum. Search reconstructs result paths from the upstream `parent` + `name` fields, never from unverified `path` or raw provider URLs. Pagination returns `total` (the **unfiltered upstream** count), `page`, `per_page`, and `has_more` (based on upstream total); after path/scope filtering, `entries.length` may be smaller than the upstream count. `get_file`, `read_text` and listing responses verify that any upstream name/path identity matches the explicitly requested file or immediate child before exposing metadata or content.

## P1 write candidates: upstream overwrite gate (2026-10-27)

The scoped Koofr acceptance mount was previously reported by the real upstream as a
WebDAV provider. Its prior upload/overwrite audit did not run a collision or
mutation test. That historical audit does not change the current seven-tool
inventory or the remaining write-operation restrictions.

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

**Updated Owner decision (Spec #309):** implement all candidate MCP tools
against the upstream API as actually provided; accept its possible overwrite,
non-atomic and backend-driver differences instead of waiting for an upstream
conditional/no-overwrite feature. These four tools remain unregistered only
until the MCP input/scope contracts and real driver behavior are implemented
and verified, not because the upstream must be modified. Preserve single-target,
fixed upstream route, explicit overwrite disclosure, unknown-write/no-retry and
basic authorization gates. Never add a second data store or patch the Fork.


A scoped `disableShare(id)` adapter is implemented and registered on this
**unmerged Draft branch**: it looks up the exact ID, verifies every referenced
file is within scope, skips already-disabled shares, dispatches at most one
fixed upstream disable request, and independently verifies the disabled state
and unchanged sanitized identity. A missing or changed post-write record is
`unknown`, never automatic success or a reason to retry. This is **not**
atomic protection against concurrent upstream share edits. The Owner has
accepted using the existing upstream behavior without an atomic update gate.
Before separately authorized production release, verify the current driver,
MCP inventory and share status using a separately approved test share. No live
share was mutated by this code-only Draft.


## Native signed download URL (Draft; not yet production)

The existing Cloudflare Route `openlist.lirtual.dpdns.org/*` was verified to
point at `openlist-tsworkers`, and anonymous GET of public settings returned
HTTP 200. `openlist_download_link` uses only `POST /api/fs/get` through the
existing internal Service Binding, validates exact file identity and the
TS-Worker HMAC signature shape, then constructs a URL on this fixed public
origin. It does **not** forward upstream `raw_url`, provider-host URLs,
credentials, headers or arbitrary redirects. No new database, API endpoint or
Fork change is required.

This adapter honors the **native** OpenList expiration setting. At the observed
`sign_all=true` and `link_expiration=0`, the signed link is **permanent**;
the MCP result marks `permanent:true`, `expires_at:null` and warns that
anyone with this bearer URL can access the file. No silent conversion to a
short-lived credential is claimed. Future production acceptance must verify
one explicitly authorized synthetic signed link through the public route,
without publishing its signature to CI logs. Code and CI alone cannot
prove the deployed configuration or driver response.

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

The existing manual selected-Worker release now defaults `openlist_portal_registration=false`. A first, separately approved publication may deploy the Worker and run read-only/scope verification **without** registering it into One-MCP. Only after the real disposable-driver E2E (including file metadata/search/text and controlled folder creation) is recorded and explicitly accepted may a **separate manual** release set `openlist_portal_registration=true`. This flag is an operator approval, not proof supplied by CI; do not set it on the first publication before actual E2E evidence. Registration still follows exact Cloudflare version/binding readback, public health, anonymous rejection and production read-only checks; it validates the authorized `tools/list` inventory and preserves all existing Portal mappings. The added input neither authorizes deployment by itself nor enables automatic releases.

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
