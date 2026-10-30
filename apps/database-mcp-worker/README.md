# Database MCP Worker · Spec #344

Cloudflare MCP Worker for bounded SQL reads, schema inspection, structured Safe Write and controlled DDL. [Spec #344](https://github.com/lirtual/mcp-workers/issues/344) defines the incremental D1 registry and future dual-transport design.

## Delivery boundary

**Production state (2026-10-29):** MySQL Direct `b2b` and `scrape_relay` remain active and
unchanged. The dedicated MySQL Hyperdrive logical connection `aiven_mysql_openlist` is
**active**, using Cloudflare Hyperdrive `aiven-mysql-openlist` for the Aiven `openlist`
database as `avnadmin`; protected activation
([Action #40834639046](https://github.com/lirtual/mcp-workers/actions/runs/40834639046))
and live read-only health / `SELECT 1` passed. Real OpenList production write and DDL
acceptance was **not performed**.

Legacy D1 test IDs `aiven_mysql_test` and `aiven_pg_test` were CAS-disabled, unbound in
[PR #460](https://github.com/lirtual/mcp-workers/pull/460), independently retired through
protected Actions, confirmed in `retired_connection_ids`, and their dedicated Cloudflare
Hyperdrive configurations removed after verifying none of the 20 current Workers refer
to them. Historical test IDs must never be reused. The Aiven project CA remains valid
and in use by the active OpenList Hyperdrive; it retains its legacy human-readable
test-oriented name because Cloudflare rejects duplicate certificate uploads (1471),
deletion while in use (1476), and updates with invalid substitute CA (2015).
Do not delete the CA or downgrade `VERIFY_IDENTITY` merely to change its name.
Prior test-only Hyperdrive E2E evidence is retained
([evidence](https://github.com/lirtual/mcp-workers/issues/344#issuecomment-6488549684)).
PostgreSQL Hyperdrive real deployed-Worker E2E remains unperformed. PostgreSQL Direct
is **out of delivery scope** under the latest Owner three-mode decision (not merely
waiting for a fixture). Spec #344 remains **Open** for the remaining accepted-mode
security and live-E2E evidence.

**Owner GitHub Actions dispatch acceptance (historical 2026-10-29 evidence only).** The Owner management page dispatched a verification-only, no-deploy request as [run #40850173389](https://github.com/lirtual/mcp-workers/actions/runs/40850173389). GitHub accepted the request and all five jobs were skipped, as designed. The existing protected release workflow now independently checks real dispatch permission before publishing the Database Worker. This proves dispatch acceptance only. It does not prove Spec #476 lifecycle completion or current PR/check permissions.

**Acceptance boundary:** The three current MySQL logical connections passed live read-only health checks. A read-only check does not establish OpenList production writes, DDL, injection/escaping or rollback safety, deployed Hyperdrive TLS negatives, or managed-D1 snapshot/key recovery. The previous Aiven test origins and IDs are retired; do not recreate them merely for compliance. PostgreSQL Hyperdrive runtime E2E remains unperformed pending a genuinely needed, separately authorized isolated origin. PostgreSQL Direct is unsupported at Owner configuration and MCP admission. Preserve existing production connections and do not infer complete three-mode acceptance from the Owner dispatch smoke.

The current managed D1 `database-mcp-registry` is the only registry.
Legacy `DATABASE_CONFIG` Secrets and original D1 were removed and verified
([evidence](https://github.com/lirtual/mcp-workers/issues/344#issuecomment-6487209015));
the original flat-catalog Worker is no longer a supported recovery target.

The new D1 `database_connections` registry supports 0–10 configured logical connections; disabled rows count. IDs, database targets and dialect/transport are immutable (credential-only URL edits; new target requires a new ID), revisions are CAS-checked, and `retired_connection_ids` prevents ID reuse on normal delete. A historical whole-D1 restore can roll back that retirement history: freeze changes and reconcile against independently retained identity evidence before allowing adds/enables.

`migrations/0001_connections.sql` and `0002_transport_and_retired_ids.sql` are the applied baseline schema. They were applied to the **new initially empty** D1 only. Do not import historical ciphertext or activate preloaded old records.

## Spec #476 implementation boundary

This local phase adds encrypted, expiring creation operations and protected unbound
candidate/allowlisted PR preparation, plus Owner final confirmation and protected apply. It does **not** complete the lifecycle. No production
API, D1 migration, deployment, database probe or lifecycle E2E was performed in this phase.
The three connection baseline and OpenList CA above are prior evidence, not a fresh readback.

- Preview is read-only. Prepare requires separate confirmation, Access/CSRF and
  verified Actions PR permission plus either a strict required-check policy or explicit
  unprotected main (classic protection HTTP 404, independently empty inherited rulesets,
  exact current main SHA and active existing CI with the expected candidate-dispatch
  definition). Unknown/403 policy responses, ambiguous rules or ineligible CI block.
  Current reported `can_approve_pull_request_reviews=false` still blocks before **any
  Cloudflare call**; only the Owner may separately enable it. No setting changes occur
  automatically. Do not broaden the existing Actions-only Owner PAT.
- `0003_hyperdrive_operations.sql` is the single additive migration (including apply run receipts), **not applied** here. Ordinary Database releases now fail their read-only
  schema gate until this migration is independently authorized and applied.
  Existing migrations, bindings and provenance are retained.
- Encrypted intake expires after 15 minutes; only after verified preparation erases the ciphertext does the nonsecret PR review window extend to seven days. Explicit Apply confirmation renews the seven-day window for CI and release. Stale or unknown side effects never retry automatically.
- The legacy direct `/setup/add` Hyperdrive reference form is removed. New Hyperdrive D1 references are created only by the protected post-release finalizer after exact version, Binding and strict TLS readback. Existing Hyperdrive references remain manageable.
- Pending adds reserve capacity against the ten-connection limit. Dispatch is claimed
  before I/O. An unknown resource creation is never replayed, even if inventory later
  appears empty. Expiry erases ciphertext; only an undispatched pending request releases
  its reservation. Unknown effects retain the ID for independent reconciliation.
  Pending operations block registry encryption-key rotation.
- Preparation verifies strict TLS/CA/cache, exact generated source and PR parent/base/head,
  both allowlisted file contents and GitHub readbacks. The PR remains
  `awaiting_confirmation` with `github_pr_ci_pending`; no merge or publication occurs.
  Protected policies retain draft PRs; confirmed unprotected main creates a ready PR,
  with the same mandatory Owner final confirmation in `/setup` and no invented reviewer.
  A bot-created PR may need human workflow approval. A dispatch result cannot substitute
  for real required PR Checks or reviews.
- CA PEM upload is supported only in separately approved **unbound Prepare**, using the existing
  Environment Cloudflare Token (Account: SSL and Certificates Write), a single D1 CA-write
  claim, deterministic certificate name and strict CA PEM content/ID readback. Lost upload
  acknowledgements are reconciled by read-only inventory, not a second POST. Existing CA IDs
  are verified read-only. Neither case changes the current OpenList CA or live configs.
  Password/CA rotations remain blocked until write-only password reconciliation and shared,
  in-flight and rollback isolation can be established. Disabling new SQL does not drain
  existing SQL. No nonfunctional password/CA apply controls are exposed.
- `/setup/hyperdrive-apply` requires Owner Access, CSRF, the exact typed logical ID,
  immutable operation UUID and explicit final confirmation checkbox. Only unexpired
  `awaiting_confirmation` creations expose it. D1 claims the dispatch before GitHub I/O;
  duplicate submissions, reruns and ambiguous outcomes never replay the action.
- The dedicated apply job in existing `release.yml` requires Owner/main, the Database
  Environment, `deploy_to_production=false`, no competing flags, and the existing release
  concurrency lock. It uses job-scoped contents/PR write and checks/statuses read; the
  existing Owner PAT dispatches only existing CI (when unprotected) and the explicit
  production release. The apply job also has `actions: read` for evidence readbacks.
  Unknown protection, unsupported rulesets, missing protected-policy admin enforcement,
  draft PRs, missing required reviews, stale main/HEAD and incomplete checks fail closed.
  For protected main, `workflow_dispatch` never satisfies required PR Checks; actual
  PR-associated checks and GitHub merge eligibility remain mandatory.
- For explicitly unprotected main, apply dispatches **existing `ci.yml`**, once, on
  `db476-<operation UUID>` with exact candidate SHA. CI restricts Owner/repository and
  Database Worker. Caller workflow context distinguishes direct dispatch from reusable
  release/acceptance CI (which inherits the caller's event), preserving those routes.
  Before candidate scripts run it verifies HEAD is a direct child of current main with exactly the two modified regular files. It has read-only contents,
  ephemeral integration databases and no production secrets or Environment.
  Apply records `ci_run_id`, verifies workflow ID/path, event, repository, Owner actor
  and triggering actor, attempt 1, exact branch/head SHA, and successful **Application
  checks, Database integration and Required checks gate** jobs. Waiting is bounded to
  60 reads, five seconds apart, within a five-minute polling window (each API read has
  its own timeout). A 204/no valid Run ID or dispatch timeout is unknown, never retried.
  Queued/incomplete CI exhausts the wait as `apply_ci_pending`; failed/skipped/missing
  or ambiguous jobs block. The page exposes the validated CI receipt and sanitized
  reason, not a completion claim. Source, main and policy/merge eligibility are re-read
  before merge; newly required PR Checks cannot be bypassed by the dispatch result.
- Apply verifies the exact two nonsecret files (ordinary blob modes, no renames),
  contents, immutable parent/base/head and current Cloudflare origin/TLS/CA/cache.
  Only an eligible PR can merge using the job token with expected head SHA. Before
  dispatch, the **actual** merge receipt, merged PR, commit parents/tree and main must
  prove one exact SHA. The pre-merge test commit is never a production SHA substitute.
  Only existing `release.yml` deploys, with `database_expected_release_sha` pinned to
  that proven SHA; its ordinary full CI and production readbacks remain authoritative.
- A verified release Run receipt is recorded as `running/apply_release_pending`, never
  completed or active; 204, timeouts or invalid receipts leave `unknown`. The shared
  concurrency lock prevents waiting for the queued release from within apply.
- The existing release dispatch carries that same operation ID as its tenth input.
  Its dependent `database-hyperdrive-finalize` job runs only after successful actual
  deployment, under the existing Environment/concurrency lock. It verifies Owner/main,
  the exact merged SHA and release Run, successful deploy job, the publish step's exact
  version at 100%, current settings and version-specific DB/all reviewed Hyperdrive
  bindings, and strict Cloudflare origin/TLS/CA/cache against the pinned manifest.
- Only that proof permits the 0003 reservation handoff: insert an immutable metadata
  reference at disabled revision 1, then complete the creation operation and erase
  ciphertext. Completion means **disabled reference handoff**, never active SQL.
  Lost D1 acknowledgements require exact row/operation readback before any retry;
  a matching prior insert can finish, while conflicts, expired/unknown operations or
  missing evidence fail closed. No rollback, overwrite or automatic activation occurs.
  Use the existing protected `/setup` activation on the new disabled ID/revision;
  live health must pass. Failed reconciliation leaves the deployment intact. Inspect
  the failed release job and operation receipts; never discard its reservation.
- Owner-disabled Hyperdrive retirement requests first stage only a fixed two-file
  **Draft** unbinding PR when a verified registry binding is still present in
  `main`. The preparer is gated by D1 disabled revision, no conflicting
  operation or shared registry reference, Owner permission preflight and a
  stable per-logical-ID Git branch; a previously accepted Draft PR can be
  resumed only after exact read-only parent/base/head, two-file SHA and Git
  blob-content verification. Unknown, stale or duplicate PRs remain blocked,
  never triggering a duplicate PR. No Cloudflare config/CA or D1
  deletion happens during this preparation. Publishing the unbind remains a
  separately reviewed Owner release; final retirement still requires a second
  request and the original exhaustive rollback-version/100%-deployment proof.
  Draft PR creation does not prove safety to merge or absence of in-flight SQL.
  The unpublished migration `0003` adds a conservative D1 `in_flight_count`
  column (no additional D1 table). Every MCP operation on a Hyperdrive ID
  atomically increments it before database work and decrements only after
  confirmed successful completion; protected disabled health probes also
  count. Disabling prevents new active MCP claims but does not cancel existing
  ones. A failed, interrupted or ambiguous operation intentionally leaves a
  positive counter; **never automatically expire or reset this counter**.
  DB-level triggers and final D1 retirement prevent deletion/rebinding while
  it is positive. This is a conservative safety signal, not a proven global
  drain: earlier Worker/rollback versions without instrumentation, pending
  backend work after a timeout, and newly initiated disabled Owner probes
  require additional version/fencing evidence. Counter zero by itself is not
  sufficient to enable automated unbinding or upstream cleanup. Per-query D1
  claim/release adds two writes for instrumented Hyperdrive executions; Direct
  has no counter mutations. Do not apply this unpublished migration to the
  production registry or release the Worker until isolated E2E and migration
  ordering are verified. An isolated Wrangler **local** D1 regression in the
  existing Database integration CI uses a synthetic UUID and temporary local
  persistence (never `--remote`) to prove all three migrations, disabled
  admission rejection, persistent in-flight delete/rebind triggers and
  immutable retired-ID tombstones. The existing production release's read-only
  D1 schema preflight now also requires the counter column and both triggers;
  this gate cannot apply migrations automatically.
  The isolated in-process MCP HTTP protocol tests exercise read, health and
  structured-write tool calls (explicit and implicit ID), including disable
  races and uncertain completion; they do not claim production Worker/SQL E2E.
  Final D1 retirement additionally checks the precise live 100%-traffic
  `version_id` in the rollback inventory, validates its immutable D1 and
  Hyperdrive binding resources, then rechecks the live deployment before the
  D1 CAS. Unverifiable active or rollback versions block retirement.
  On 2026-10-30 an **unmodified production read-only inventory** found 26
  deployable Database Worker versions: 13 still hold the existing Aiven
  Hyperdrive binding and 13 do not. The current deployment uses one version
  at 100%, included in the deployable inventory. Current settings of all 21
  account Workers were inspected; only `database-mcp-worker` currently binds
  this config. This is **not** evidence about the other Workers' history,
  external accounts or in-flight SQL. The production registry still has only
  migrations `0001` and `0002`; `0003` (durable in-flight fence) is unapplied.
  Do not purge old Worker versions, force artificial deployments to age them
  out, auto-apply D1 migrations or delete the original Hyperdrive/CA. Use the
  existing release preflight and an explicit independently reviewed migration
  plan when a production cutover is authorized. Failure to satisfy any of the
  above must leave the Draft and live connections unchanged. A synthetic
  26-version regression exercises both the 13 retained-binding refusal and
  clean-inventory-only D1 CAS path, without production writes.
  The CI release contract deliberately refuses automatic unbinding PR merge or
  release from the retirement staging job: neither the disabled D1 flag nor
  the bounded 60-second SQL query timeout alone is a verified global in-flight
  operation census. Until an independently checkable drain/isolation contract
  exists, maintain the separate GitHub PR review and pinned manual release
  path. Never infer safe deletion or rollback from a clean Draft PR.
  Credential and CA rotation now have an **isolation preflight only** in the
  existing protected `release.yml` (`database-hyperdrive-rotation-check`) and
  Owner `/setup`. It accepts a disabled ID, exact revision, and one of
  `credentials` or `ca`, with **no passwords, CA PEM, resource writes or
  deployment**. The Runner reads D1 status/in-flight/unfinished operations,
  current CA/TLS/cache config, all current account Worker settings, and each
  Worker's deployable version bindings including active-version receipts.
  Any referenced version, incomplete inventory, shared registry, stale D1,
  source Binding, version drift or missing migration blocks the check. Before
  returning eligibility, the Runner rechecks the complete Worker/version
  inventory, exact Hyperdrive origin/CA/TLS settings, active deployment and
  D1 revision, so changes during the read-only scan fail closed. The
  single optional rotation mode brings existing `release.yml` to ten inputs;
  all other lifecycle and production jobs explicitly reject a rotation mode.
  Passing this preliminary check is neither a mutation approval nor a global
  drain certificate: repeat evidence under a separately reviewed write
  action, reconcile unknown outcomes, and retain the old CA/version until
  safety is proven. **The password/CA write phase is not implemented.**
  Production `0003` is still unapplied and the 13 retained-version references
  block in-place changes. Do not disable production connections merely to
  make this readiness check pass. An isolated independent Hyperdrive candidate
  plus reviewed binding switch remains the safe option for shared configs.
  `/setup` provides a separate **Check unbinding PR (read-only)** action for a
  disabled Hyperdrive ID and expected revision. It looks up only the stable
  branch in the same repository and allows only the two reviewed source-file
  paths; the result distinguishes Draft, review-ready, merged and closed without
  merge. A merged PR is **not** proof of an exact production release, active
  binding removal or D1 retirement. No GitHub write, D1 mutation or deployment
  is performed by the status check.
- Enable/retire use shared `database_hyperdrive_id` and
  `database_hyperdrive_revision` inputs with their respective explicit approval flag.
  Release dispatch has exactly ten inputs; `database_hyperdrive_apply_id` is the only new input in this continuation. Retirement checks
  every returned deployable rollback version before D1 CAS/tombstone and always retains
  upstream Hyperdrive/CA. Unconfirmed rollback inventory blocks retirement; shared CA
  deletion is never inferred from removal of one logical connection.

## Transport contracts

**Approved mode matrix:** MySQL Direct, MySQL Hyperdrive and PostgreSQL Hyperdrive.
PostgreSQL Direct is deliberately unsupported, even with plaintext consent.
The Owner form does not offer it, and MCP admission rejects it even if an older D1
record were marked active. PostgreSQL Hyperdrive still needs a dedicated, verified
Cloudflare Binding and mode-specific live E2E before acceptance.

| Transport | Origin data | Connection security | Changes |
|---|---|---|---|
| **Direct** | AES-256-GCM encrypted URL per D1 row | **Plaintext TCP**, explicitly insecure; credentials and SQL can be intercepted | Direct records may be changed individually with no Worker release |
| **Hyperdrive** | Nonsecret config ID and binding name in D1; origin password and CA only in Cloudflare | **Must be separately proven** strict chain/hostname TLS and disabled caching at the Hyperdrive → origin boundary | Dedicated Cloudflare config and versioned Worker binding through the existing protected GitHub Actions release |

## Owner-triggered Hyperdrive Actions

The existing Owner-only `/setup` page can request `enable` or `retire` for a **disabled** Hyperdrive D1 reference. Each request is gated by the existing exact Owner Access identity, Origin and CSRF checks, revision validation, and exact ID confirmation for retirement. The Worker calls only the allowlisted `release.yml` GitHub `workflow_dispatch` endpoint on `main` with `deploy_to_production=false`. The existing protected Action independently verifies `github.actor=lirtual`, immutable main, Cloudflare binding/origin/CA/cache, live health or unbinding evidence, and D1 CAS. A GitHub HTTP 204 (no body) or validated HTTP 200 (Workflow Run ID included) confirms **request acceptance only**, not workflow completion. GitHub REST requires a valid `User-Agent` header, explicitly set to `lirtual-database-mcp-worker` on both Worker and Runner paths (otherwise GitHub can reply 403 even when the PAT is valid). Cloudflare Workers does **not** support Fetch `redirect: 'error'` (it throws before I/O); the dispatcher uses `redirect: 'manual'`, rejects all HTTP 3xx without forwarding the PAT, and has a workerd-like regression test in the existing unit suite. The dispatcher opts into `return_run_details`, displays a numeric run ID when supplied, and classifies 401/403/404/422/429/5xx, network ambiguity, and invalid receipts using fixed redacted diagnostics; it never reflects provider response bodies or token values. Do not automatically retry an ambiguous dispatch: inspect Actions history first. The Owner Maintenance section also offers **Check GitHub Actions connection**: a CSRF-protected, non-destructive dispatch with `worker=database-mcp-worker`, `deploy_to_production=false` and all other approval flags false, so none of the existing `release.yml` jobs runs. This checks the deployed PAT's actual GitHub dispatch permission without modifying D1, any database, Hyperdrive, or the Worker. A 200 run ID makes it possible to match a specific received request against the GitHub Actions run log. The Owner should inspect the GitHub Actions run separately; the page does not claim an end-to-end workflow success solely from 204.

The Owner page uses the **GitHub Environment Secret** `DATABASE_GITHUB_ACTIONS_TOKEN` under environment `database-mcp-worker`: a fine-grained, Owner-owned GitHub PAT restricted to repository `lirtual/mcp-workers` with only `Actions: Read and write`. The existing `release.yml` job uses `environment: database-mcp-worker`, stages this secret with the other selected-Worker credentials, and publishes it via Wrangler `--secrets-file`; it also verifies the required Cloudflare Secret binding after deployment. The PAT must not be separately maintained in the Cloudflare Dashboard. Never put this PAT into D1, public variables, page fields, logs, repository files, or GitHub workflow inputs. Missing or invalid credentials prevent the deployment before publication; a revoked or unauthorized token also fails closed at dispatch time, while existing SQL operations remain unaffected. This token can dispatch any permitted workflow within its repository scope, so limit and rotate its grant carefully. The existing Database Worker release now gates publication on **one actual non-destructive GitHub dispatch using the same Environment PAT** (no-deploy/no-approval flags, so all mutation jobs are skipped). A denied request fails before publishing and reports a fixed sanitized cause such as `token_missing_actions_write_or_repo_scope`; no provider response text, headers, or token is logged. This prevents another apparent CI pass based only on the presence of a secret without proof that the owner workflow can actually be dispatched. The incremental #476 preparation path below stages encrypted origin input; password/CA updates and post-release activation remain blocked as described above. An initial retirement request may stage a Draft PR removing the reviewed Binding/manifest (no deployment); after separate review and ordinary Owner release, a later request can run the protected final D1 retirement proof. The retirement Action never directly changes deployed Worker bindings or deletes Cloudflare Hyperdrive/CA resources.

The Owner `/setup` page uses Cloudflare Access exact-email OTP, native Access identity with strict signed-JWT fallback, Origin/CSRF checks and throttling. Direct creation and sensitive credential edits require plaintext-risk acceptance. A logical ID must keep the same host/IP, port and database; changing target requires a new ID. Passwords, URLs, CA, keys and ciphertext are never displayed. Direct supports only MySQL, with explicit plaintext-risk acceptance; PostgreSQL Direct requests fail closed. Hyperdrive references enter D1 **disabled** and require protected Owner/main GitHub Actions activation with Cloudflare readback and a signed, bounded read-only Worker preflight **before** D1 becomes active. The private `/internal/hyperdrive-health` route requires existing MCP bearer auth plus a short-lived HKDF-derived HMAC proof from the existing Owner Actions encryption-key Secret; it accepts only a disabled Hyperdrive ID and exact revision, runs health only, never writes D1, and returns no secrets. Failed probes leave D1 disabled. MySQL Hyperdrive `aiven_mysql_openlist` is active; no PostgreSQL Hyperdrive connection is currently configured. PostgreSQL Hyperdrive acceptance remains unperformed.

**Important gate:** `hyperdrive-bindings.json` is the reviewed nonsecret binding/config-ID + origin/CA provenance mapping, containing the current reviewed OpenList Hyperdrive binding. Each real entry must contain `binding`, `id`, `dialect`, `origin_host`, `origin_port`, `origin_database`, and `ca_certificate_id`. The origin password and PEM must NEVER appear in that file. The existing GitHub Actions release uses a read-only Cloudflare Hyperdrive GET (requires **Hyperdrive Read** on its existing token) both before and after deployment to compare the exact origin and CA, require PostgreSQL `verify-full` / MySQL `VERIFY_IDENTITY`, and require `caching.disabled=true`. The release preflight compares it against the reviewed Wrangler `hyperdrive` entries and readback checks the deployed IDs. Runtime rejects any missing or mismatched Binding. This alone **does not prove** source Hyperdrive configuration, CA trust, hostname validation, disabled query cache, pool restart, or rollback-version safety; these remain mandatory external verification gates before any Hyperdrive activation. No account-management token is embedded in the production Worker.

For MySQL Hyperdrive, the driver cannot use protocol-level prepared `execute()`. Structured writes use `query(sql, params)` only for primitive values and verify `NO_BACKSLASH_ESCAPES` is absent from the **same transaction/session immediately before interpolation**. This is **not a server-side parameter binding**, and deployed Workers escaping/injection/rollback tests remain P0 requirements. PostgreSQL Hyperdrive must respect transaction pooling. Never retry ambiguous non-idempotent commits.

The existing MCP tools remain: `list_connections`, `inspect_schema`, `get_schema_context`, `query_read`, `explain`, `health_check`, `insert_rows`, `update_rows`, `delete_rows`, `create_table`, `alter_table`, `create_index`, `drop_index`, `drop_table`. Existing row, result-byte, query-time and write-affected-row limits remain.

## Security and release checks

Direct public-host/DNS/address checks are retained, with documented DNS rebinding/TOCTOU residual risk. Never use Direct with a server requiring encrypted database traffic. Database GRANT/RLS and transactional engine properties remain the authorization and rollback boundaries.

The Worker requires `MCP_ACCESS_TOKEN`, `DATABASE_ENCRYPTION_KEY`, `DATABASE_KEY_ID`, `DATABASE_GITHUB_ACTIONS_TOKEN`, a dedicated D1 `DB` binding, `RATE_LIMITER`, `SETUP_RATE_LIMITER`, and the existing Owner Access Variables. Bounded CAS key rotation applies **only to encrypted Direct records**; retained rollback versions and backups must be compatible with both current and historic encryption keys.

For subsequent releases use only existing protected GitHub Actions with read-only D1/Access/binding gates and exact active-version checks; the old importer and legacy rollback dispatch are retired. For a sensitive Hyperdrive Cloudflare change: disable the logical connection, change the dedicated upstream config with approved access, restart/drain its native pool, verify **new connections** and TLS/caching/binding provenance, then explicitly enable. Failures remain disabled. To retire a Hyperdrive record, first disable it, review older rollback-version and external consumers, remove its Binding and manifest entry in a reviewed GitHub release, verify that release in production, then dispatch the existing protected Release Worker with `database_hyperdrive_retire_approved=true`, `database_hyperdrive_id` and `database_hyperdrive_revision`. The guarded job verifies unbound current production, CAS-deletes only the disabled D1 record, and confirms permanent ID retirement; it never deletes Cloudflare config/CA. The Owner separately reviews old versions, other consumers and CA dependencies before any upstream resource deletion. Do not add auto-cleanup or another orchestrator.

```bash
pnpm --filter database-mcp-worker check
node --test scripts/manual-worker-release.test.mjs
```

Unit tests and dry-run are not deployed Workers acceptance. MySQL Direct and MySQL Hyperdrive have separate production E2E evidence. No PostgreSQL Hyperdrive connection is currently configured, and PostgreSQL Direct lacks an accepted plaintext origin; neither has current runtime E2E evidence. The now-retired Aiven test hosts previously passed origin-side CA and hostname negatives, which do not replace deployed Workers TLS-negative acceptance on current origins. Real production writes and DDL were exercised only against a dedicated test table and cleaned up; no authorization to modify existing business tables follows. See [production cutover and rollback](../../docs/database-cutover-344.md), [historical Direct TLS investigation](docs/direct-tls-feasibility.md), and [Spec #344](https://github.com/lirtual/mcp-workers/issues/344).

## License

MIT; upstream provenance retained in `LICENSE` and `SOURCE.md`.
