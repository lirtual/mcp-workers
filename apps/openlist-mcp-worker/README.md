# OpenList MCP Worker · Spec #309

## Verified production status (2026-10-28)

**Completed: 18/18 MCP tools active; 0 disabled.** Allowed logical root:
`/Koofr/Downloads`. All five formerly gated native operations
(`openlist_delete`, `openlist_share_create`, `openlist_share_update`,
`openlist_share_enable`, `openlist_share_revoke`) are registered and
production-tested. This MCP Worker uses the existing OpenList REST APIs
through Cloudflare Service Binding. The upstream `lirtual/OpenList-Worker`
Fork remains unchanged.

### Verified production evidence

- Initial 18-tool release and Portal registration: existing manual
  [release #40620850171](https://github.com/lirtual/mcp-workers/actions/runs/40620850171).
- [PR #405](https://github.com/lirtual/mcp-workers/pull/405) hardened the
  acceptance script against replaying an uncertain final disable.
  [PR #406](https://github.com/lirtual/mcp-workers/pull/406) fixed Koofr
  delete postflight: a successful native removal followed by exact
  absence in a complete, refreshed parent listing can confirm deletion
  when missing-file GET fails. An unknown write result is never replayed.
  The existing manual [release #40629725043](https://github.com/lirtual/mcp-workers/actions/runs/40629725043)
  **succeeded** with KV/storage, Service Binding, health and anonymous
  denial checks; no Portal re-registration.
- Full isolated real share/delete lifecycle:
  [E2E #40629908697](https://github.com/lirtual/mcp-workers/actions/runs/40629908697)
  **Success** (13 steps); create, update, disable, enable, second
  disable, revoke, public access/denial and exact single-file deletion.
  An independent production directory listing confirmed `total=0`.
- Permanent-signature refusal:
  [E2E #40630366024](https://github.com/lirtual/mcp-workers/actions/runs/40630366024)
  **Success** (13 steps). The upstream supplied a non-expiring
  `0.<signature>` for an isolated test file, and production MCP
  `openlist_download_link` returned `NOT_SUPPORTED` rather than a
  permanent bearer URL. The test did not run real share lifecycle
  operations. Disposable native file fixtures remain for separately
  authorized cleanup.

### Actual safety boundaries

- The upstream token remains administrator-equivalent; root filtering is
  **logical**, not physical storage isolation. Native operations remain
  non-atomic; unknown dispatched writes must not automatically retry.
- ChatGPT's `Always ask` and MCP tool annotations are **client-side**
  approval mechanisms, not unbypassable human authorization attested by
  the Worker.
- Permanent-signature blocking is **MCP-only**. OpenList upstream still
  uses `sign_all=true` and `link_expiration=0`, and can issue permanent
  URLs directly. This policy does not revoke previously issued links.
- Historical isolated test folders remain unless separately approved
  for precise cleanup. No new Worker, deployment system, CI, staging
  environment or Fork modification was introduced.

See [Spec #309](https://github.com/lirtual/mcp-workers/issues/309)
for the original decisions, audit history and failure evidence.

---

## Historical implementation and security notes (superseded)

The following sections preserve intermediate 13/18-tool states and
earlier candidate designs for traceability. Statements describing tools
as still unregistered or MCP as returning permanent links refer to
**historical stages**, not the verified current deployment above.

## Historical: five high-risk tool candidate (subsequently released)

The Owner approved using ChatGPT's OpenList-specific **Always ask** app permission
and existing MCP identity, logical root checks, bounded native REST arguments,
non-atomic readback, and `unknown` **never retry** semantics as the pragmatic
basis for acceptance of the five previously gated operations. This accepts
that `Always ask` and MCP tool annotations are **client-side signals**, not
Worker-attestable, per-invocation human authorization. There is no additional
approval store, second Worker, or model-supplied `confirmation=true` shortcut.

**Current production remains 13/18**. The candidate branch adds registration
of `openlist_delete` (one **file**, not directories), `openlist_share_create`
(random password returned once, 1–168 hour expiry, 1–100 access limit,
1–8 explicit paths), `openlist_share_update` (expiry and/or access limit),
`openlist_share_enable`, and `openlist_share_revoke` (share record only,
never source files). Each exposes accurate destructive/external-access
annotations; the upstream administrator-equivalent API Token is unchanged.

This is a **candidate**, not authorization to change the production Worker or
Portal. Before release, require isolated production E2E on exact disposable
objects for each of the five operations: accepted action and independent
readback; out-of-scope/invalid/no-op negatives; one-call/no-retry on unknown;
external share access effects; file-delete verified only against new disposable
test content. No existing user file/share or retained fixture is a permitted
test target without its own precise authorization. Use existing manual GitHub
Actions, no scheduled deployment. The permanent signed URL refusal from original [PR #386](https://github.com/lirtual/mcp-workers/pull/386)
has already been **integrated into this #387 candidate** (the duplicate #386
was closed unmerged). This combined proposal must still pass independent
production release and read-only link-policy verification.

## Share-disable consistency: evidence and safe interpretation

The deployed native `/api/share/disable` handler changes one record then
writes it through `saveDb`; `/api/share/get` reads from `getDb` (official
[OpenList share handler](https://github.com/OpenListTeam/OpenList-Worker/blob/29b7a8eb687aa5daf6cd2158fa27d83232ebae6f/src/backend/server/share.ts)).
The upstream model has an internal **1,000 ms database cache** and refreshes
its same-request cache on writes
([upstream model](https://github.com/OpenListTeam/OpenList-Worker/blob/29b7a8eb687aa5daf6cd2158fa27d83232ebae6f/src/backend/internal/model/db.ts)).
Whether another Worker instance reads a current value immediately also
depends on its configured persistence backend. These mechanisms are
**possible contributors**, not a demonstrated root cause of the failed
immediate acceptance read; the sanitized job log does not reveal the exact
post-write response. Avoid treating one 200 or same-request cache hit as
proof of global, immediate share revocation.

A new, unexpired synthetic share was subsequently tested in
[one-shot run #40612383719](https://github.com/lirtual/mcp-workers/actions/runs/40612383719),
which passed both immediate independent metadata readback and an explicit
public **disabled** rejection. That success **narrows** the previous
acceptance gap; it does not explain the older unknown outcome or prove
cross-instance read-after-write latency bounds. Its one-shot mutation
entrypoint has been removed from the manual workflow.

For any *future separately authorized* share-disable acceptance, require
exact ID and file-scope preflight, at most one write, an independent
post-write state check, and a clear `unknown` / non-retry result when
verification fails. Read-only follow-up is safe; another effectful write
is not. The historical test share was **already expired**, so it does not
verify active public-link invalidation or latency. No Fork, storage
backend, Portal or global link-expiration setting was changed here.

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

## Historical: 13-tool inventory (superseded)

`openlist_capabilities`, `openlist_list_files`, `openlist_get_file`,
`openlist_search_files`, `openlist_read_text`, `openlist_share_get`,
`openlist_download_link`, `openlist_share_disable`, `openlist_rename`,
`openlist_copy`, `openlist_move`, `openlist_upload_small`,
`openlist_create_folder` (**thirteen registered and deployed**).

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
may remain expired upstream, but cleanup is out of scope. The five remaining
candidates stay disabled in production pending real driver/conflict, scope, approval, and
share-lifecycle safety evidence. Do not infer physical storage confinement from
the admin-equivalent upstream token. Every future production release requires
its own authorized checks.

Folder creation first checks a complete bounded parent listing for collisions, then verifies the created directory via a separate read. This is **not an atomic no-overwrite guarantee**. Missing preflight evidence prevents dispatch; post-dispatch uncertainty is never treated as a confirmed success or retried automatically. Mutations are non-atomic. UTF-8 file reads disallow redirects, require byte-for-byte agreement with upstream file metadata size, and are bound to supported text types and a 256 KiB maximum. Search reconstructs result paths from the upstream `parent` + `name` fields, never from unverified `path` or raw provider URLs. Pagination returns `total` (the **unfiltered upstream** count), `page`, `per_page`, and `has_more` (based on upstream total); after path/scope filtering, `entries.length` may be smaller than the upstream count. `get_file`, `read_text` and listing responses verify that any upstream name/path identity matches the explicitly requested file or immediate child before exposing metadata or content.

## Historical: P1 write candidates and overwrite audit (2026-10-27)

The scoped Koofr acceptance mount was previously reported by the real upstream as a
WebDAV provider. Its prior upload/overwrite audit did not run a collision or
mutation test. That historical upstream source audit remains a driver-risk note; the current production inventory is thirteen tools, with non-atomic writes and overwrite risks explicitly disclosed.

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
conditional/no-overwrite feature. Upload, rename, copy and move are now registered in production against native REST routes with scope and unknown-write checks. The controlled Koofr native-driver E2E #40606166139 passed; this remains non-atomic, overwrite-capable behavior, not general race/driver safety proof. Preserve single-target,
fixed upstream route, explicit overwrite disclosure, unknown-write/no-retry and
basic authorization gates. Never add a second data store or patch the Fork.


A scoped `disableShare(id)` adapter is **registered in production**. It
looks up the exact share ID and verifies all referenced file paths are in
scope, sends at most one `/api/share/disable`, then checks the ID/state
again. Non-atomic upstream changes and unknown write outcomes are reported
without automatic replay. **A real share-disable operation and independent
readback against an approved isolated share are still pending.** Prior
controlled share-create/get evidence is not a substitute. The temporary
`openlist_share_create` acceptance route has been retired; do not
re-enable it solely for this test.

## Historical: native signed-link lifetime risk

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
short-lived credential is claimed. The synthetic signed-link fetch passed in real Koofr E2E #40606166139 without exposing its signature in logs. This does not provide a finite expiry when upstream returns `link_expiration=0`; formal acceptance of the non-expiring bearer risk remains pending.


### Historical proposal: MCP-only safeguard (now deployed)

This combined #387 candidate's fail-closed change to `openlist_download_link` rejects an upstream
`0.<signature>` (non-expiring) token with `NOT_SUPPORTED` **before** a public
bearer URL is constructed or returned. Finite, unexpired native signatures
continue to work with their **actual upstream expiry**, without claiming a
short-lived guarantee. The existing tool name and Portal inventory remain
unchanged, and `openlist_read_text` continues to fetch content through its
private Service Binding (it never returns a signed URL to the client).

This is an **MCP output policy**, not an OpenList configuration or signer
change. It cannot revoke signed URLs already issued or issued directly by
OpenList, and it does not prove link-expiration policy for the OpenList site.
The current production worker still returns permanent URLs until a **separately
approved, manually triggered Worker release** deploys this change.
The existing manual Koofr driver acceptance must verify a native permanent
signature was refused without publicly fetching it, or test and retrieve an
actual finite-expiry link. The Owner has not accepted permanent-link risk.


## Native file operations (current production)

`openlist_rename` maps to `POST /api/fs/rename` for a single canonical
source and new name in the same parent. `openlist_copy` and `openlist_move`
map to `POST /api/fs/copy` and `POST /api/fs/move`, passing exactly one
name and a scoped source/destination folder. They do not introduce a new
conditional API, attempt silent rollback, or require a Fork patch.

`openlist_upload_small` uses the existing `PUT /api/fs/put` with a strict
`File-Path` header, UTF-8 or canonical Base64 bytes, and a 1 MiB cap.
It verifies the destination's file identity and size afterward but never
claims byte identity or atomic no-overwrite. The existing driver can
overwrite an existing destination. The returned
`native_may_overwrite:true` and warnings are intentional. A successful
readback only proves that the destination was observed; it does not prove
transactional integrity or the absence of a concurrent change. After a
possibly dispatched write, any uncertainty returns `unknown` and **must not**
be automatically retried. A controlled real Koofr fixture acceptance passed in #40606166139 independently of code CI. No normal user files were used as test data.

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

## Historical: five API adapters before production registration

The Worker also implements internal `createShare`, `updateShare`, `enableShare`,
`revokeShare` and `deleteFile` methods against existing OpenList REST APIs.
A bounded create operation generates one random ID and one one-time share password,
limits expiry/accesses, validates every scoped file and checks the newly created
record. Updates allow only expiry and access limits. Enable/revoke require an
exact scoped share ID; revoke deletes only share metadata. Delete accepts one
in-scope **file**, never a directory. Post-write outcomes are independently
observed; uncertain effects are **never retried**.

**None of these five are registered as production MCP tools**: the spec requires
trusted client human approval for external sharing and irreversible deletion,
not a model-supplied boolean. CI tests the internal adapters and confirms forged
MCP `tools/call` messages cannot dispatch these actions. No real share or file
is mutated in offline acceptance. This does not require modifying the Fork.

## Historical: former 13-tool Portal inventory gate

The existing `scripts/register-openlist-portal.mjs` and its offline regression
contract requires exactly the thirteen production MCP tools; a stale seven-tool deployment fails before any Portal mutation. This keeps the existing
fail-closed Portal inventory check: a stale 7-tool deployment or an unexpected
extra destructive tool **fails before changing Portal mappings**. The five
internal-only share/delete adapters remain absent from this inventory.

Current Worker release #40606014736 and real Koofr E2E #40606166139 have passed, but the release deliberately skipped Portal registration. Future Portal inventory changes need separate approval and readback; the public MCP capability count is already thirteen.

## Expanded native API driver acceptance (manual only)

The existing `OpenList Driver Acceptance` workflow adds a **default-off**
`confirm_native_tool_tests` switch. It is effective only when the existing
`confirm_disposable_write=true` is independently approved, the run is on
current `main`, and the deployed Worker already contains the candidate tools.
No new workflow, environment, credentials or automatic release is introduced.

The enhanced path uses **one fresh, approved synthetic Koofr test folder**
with exact run-scoped children, and exercises MCP `upload_small`, `copy`,
`rename`, `move`, small text readback, signed URL construction **and a real anonymous HTTPS
GET of its exact synthetic bytes** (no redirects), plus a scope-denial case. The existing default path is unchanged. The test will
leave its synthetic files for separately approved cleanup, never overwrite
normal user paths or mutate retained prior runs, and does not print the
sensitive signed URL. This step **does not** create, disable or revoke
shares, or delete files: those operations require separate authorization.
Driver acceptance cannot run against an unmerged PR without production
publication; it must not be marked Pass based on offline tests alone.

## Manual acceptance approval-combination gate

The existing OpenList acceptance workflow now runs a small, **secret-free**
`selection-gate` before its driver or Portal jobs. It requires trusted
`main` and exactly one authorized mode: disposable fixture write (optionally
with native adapter tests) **or** Portal-only registration. Missing approval,
conflicting choices, or selection of native tests without fixture-write
approval **fails the workflow**, rather than silently skipping every job
and producing a misleading green result. This does not deploy or publish.

## Native rename and move readback improvement

A destination path may already exist, so verifying its presence after a nominal
upstream success does not prove that a rename or move occurred. The MCP adapter
now additionally observes **absence of the old source path** for rename/move;
if either check cannot be established the result is `unknown`, never a false
success and never an automatic retry. Copy intentionally keeps its source.
This is an MCP post-condition check, **not** a new upstream atomic primitive.
