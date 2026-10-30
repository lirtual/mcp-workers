# Database MCP Worker · Spec #344

## Latest verified state (2026-10-30; supersedes historical sections below)

- Worker version `b016569e-dbc8-4cc1-9aa6-fc91efae967f`
  serves **100%**. Reviewed Hyperdrive bindings point to isolated
  PostgreSQL `eb4ccbd231ea44beabc72b3f2b483d69`
  (`verify-full`) and isolated MySQL
  `38bf39b569484dbb8a9fe1b24f0df854`
  (`VERIFY_IDENTITY`); each has a CA and disabled SQL caching.
- Current D1: **active** `db344_pg_e2e`, `b2b`,
  `scrape_relay`; **disabled** `aiven_mysql_e2e` and
  `aiven_mysql_openlist`. Prior MySQL test activation was a
  historical successful test and does not imply it is active today.
  PostgreSQL Hyperdrive health remains **PASS**.
- Live isolated PostgreSQL Hyperdrive read/DDL/write, actual RLS
  tenant enforcement, guarded UPDATE/DELETE transaction rollback
  and final cleanup have all **PASS** evidence in
  [Spec #344](https://github.com/lirtual/mcp-workers/issues/344#issuecomment-6514431922).
- The live **origin** OpenSSL 6/6 certificate/hostname matrix
  passed on Aiven PostgreSQL and MySQL
  ([evidence](https://github.com/lirtual/mcp-workers/issues/344#issuecomment-6514521721)).
  It does **not** prove a deliberately misconfigured **Hyperdrive**
  client's CA/hostname rejection. The latter remains
  **NOT PERFORMED / BLOCKED**: creation of an isolated proof config
  was stopped by platform safety checks. Do not bypass the block,
  reuse live origin secrets or change healthy production configs.
- The existing strict TLS/config-drift test suite was added to
  mandatory existing CI via [PR #523](https://github.com/lirtual/mcp-workers/pull/523).
  Main [CI #41000595512](https://github.com/lirtual/mcp-workers/actions/runs/41000595512)
  succeeded; there was no new Worker publication. An offline
  regression is not a substitute for real Hyperdrive handshake failure.

Only resume blocked Hyperdrive-client negative E2E with a separately
allowed disposable config/origin and protected credential handling;
otherwise leave #344 Open until an explicit Owner evidence-gap waiver.
See [current operator runbook](../../docs/database-cutover-344.md).

## Earlier Aiven MySQL test activation record (historical)

The independent Aiven MySQL Hyperdrive source was published with
[release #40995674654](https://github.com/lirtual/mcp-workers/actions/runs/40995674654)
and initially activated with
[Owner activation #40996046557](https://github.com/lirtual/mcp-workers/actions/runs/40996046557).
That connection subsequently became disabled; its earlier read-only
E2E remains a historical success, not evidence of a currently
active connection.

## Previous incident snapshot (before replacement test config; historical)

- At the earlier incident snapshot Cloudflare listed only the isolated PostgreSQL Hyperdrive E2E config `eb4ccbd231ea44beabc72b3f2b483d69` (`verify-full`, caching disabled). The old OpenList MySQL config `135ef2e15db049c68e99b0849f9a3da0` is **deleted**: direct API GET returns 404, which blocked the protected release. The reviewed Wrangler and manifest entry for the deleted config have now been removed in source.
- D1 formerly listed `aiven_mysql_openlist` as Active with a failing health check; the Owner later disabled that row (revision 3). It is not a working connection. Never recreate the deleted MySQL config solely to satisfy a release check.
- `b2b` and `scrape_relay` MySQL Direct health checks pass and remain unchanged. After PR #515 cleanup the PostgreSQL E2E binding was the only reviewed binding. The new test MySQL binding staged above is a separate subsequent source change. A released Worker binding and real PostgreSQL SQL/RLS/DDL/TLS E2E still require independent production verification.

## Earlier delivery and acceptance history (historical, superseded by the state above)

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

**Owner GitHub Actions production E2E (2026-10-29): PASS.** The Owner management page dispatched a verification-only, no-deploy request as [run #40850173389](https://github.com/lirtual/mcp-workers/actions/runs/40850173389). GitHub accepted the request and all five jobs were skipped, as designed. The existing protected release workflow now independently checks real dispatch permission before publishing the Database Worker. No further Owner interaction or credentials are required for this integration.

**Acceptance boundary:** The three current MySQL logical connections passed live read-only health checks. A read-only check does not establish OpenList production writes, DDL, injection/escaping or rollback safety, deployed Hyperdrive TLS negatives, or managed-D1 snapshot/key recovery. The previous Aiven test origins and IDs are retired; do not recreate them merely for compliance. PostgreSQL Hyperdrive runtime E2E remains unperformed pending a genuinely needed, separately authorized isolated origin. PostgreSQL Direct is unsupported at Owner configuration and MCP admission. Preserve existing production connections and do not infer complete three-mode acceptance from the Owner dispatch smoke.

The current managed D1 `database-mcp-registry` is the only registry.
Legacy `DATABASE_CONFIG` Secrets and original D1 were removed and verified
([evidence](https://github.com/lirtual/mcp-workers/issues/344#issuecomment-6487209015));
the original flat-catalog Worker is no longer a supported recovery target.

The new D1 `database_connections` registry supports 0–10 configured logical connections; disabled rows count. IDs, database targets and dialect/transport are immutable (credential-only URL edits; new target requires a new ID), revisions are CAS-checked, and `retired_connection_ids` prevents ID reuse on normal delete. A historical whole-D1 restore can roll back that retirement history: freeze changes and reconcile against independently retained identity evidence before allowing adds/enables.

`migrations/0001_connections.sql` and `0002_transport_and_retired_ids.sql` remain the reviewed additive schema. They were applied to the **new initially empty** D1 only. Do not import historical ciphertext or activate preloaded old records.

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

The Owner page uses the **GitHub Environment Secret** `DATABASE_GITHUB_ACTIONS_TOKEN` under environment `database-mcp-worker`: a fine-grained, Owner-owned GitHub PAT restricted to repository `lirtual/mcp-workers` with only `Actions: Read and write`. The existing `release.yml` job uses `environment: database-mcp-worker`, stages this secret with the other selected-Worker credentials, and publishes it via Wrangler `--secrets-file`; it also verifies the required Cloudflare Secret binding after deployment. The PAT must not be separately maintained in the Cloudflare Dashboard. Never put this PAT into D1, public variables, page fields, logs, repository files, or GitHub workflow inputs. Missing or invalid credentials prevent the deployment before publication; a revoked or unauthorized token also fails closed at dispatch time, while existing SQL operations remain unaffected. This token can dispatch any permitted workflow within its repository scope, so limit and rotate its grant carefully. The existing Database Worker release now gates publication on **one actual non-destructive GitHub dispatch using the same Environment PAT** (no-deploy/no-approval flags, so all mutation jobs are skipped). A denied request fails before publishing and reports a fixed sanitized cause such as `token_missing_actions_write_or_repo_scope`; no provider response text, headers, or token is logged. This prevents another apparent CI pass based only on the presence of a secret without proof that the owner workflow can actually be dispatched. Passwords, CA PEM, TLS and database target changes remain Cloudflare-managed and out of scope for webpage dispatch. Binding removal requires a reviewed source change plus ordinary release **before** retirement is requested; the retirement job never removes Worker bindings or Cloudflare resources itself.

The Owner `/setup` page uses Cloudflare Access exact-email OTP, native Access identity with strict signed-JWT fallback, Origin/CSRF checks and throttling. Direct creation and sensitive credential edits require plaintext-risk acceptance. A logical ID must keep the same host/IP, port and database; changing target requires a new ID. Passwords, URLs, CA, keys and ciphertext are never displayed. Direct supports only MySQL, with explicit plaintext-risk acceptance; PostgreSQL Direct requests fail closed. Hyperdrive references enter D1 **disabled** and require protected Owner/main GitHub Actions activation with Cloudflare readback and a signed, bounded read-only Worker preflight **before** D1 becomes active. The private `/internal/hyperdrive-health` route requires existing MCP bearer auth plus a short-lived HKDF-derived HMAC proof from the existing Owner Actions encryption-key Secret; it accepts only a disabled Hyperdrive ID and exact revision, runs health only, never writes D1, and returns no secrets. Failed probes leave D1 disabled. MySQL Hyperdrive `aiven_mysql_openlist` is active; no PostgreSQL Hyperdrive connection is currently configured. PostgreSQL Hyperdrive acceptance remains unperformed.

**Important gate:** `hyperdrive-bindings.json` is the reviewed nonsecret binding/config-ID + origin/CA provenance mapping, containing the current reviewed OpenList Hyperdrive binding. Each real entry must contain `binding`, `id`, `dialect`, `origin_host`, `origin_port`, `origin_database`, and `ca_certificate_id`. The origin password and PEM must NEVER appear in that file. The existing GitHub Actions release uses a read-only Cloudflare Hyperdrive GET (requires **Hyperdrive Read** on its existing token) both before and after deployment to compare the exact origin and CA, require PostgreSQL `verify-full` / MySQL `VERIFY_IDENTITY`, and require `caching.disabled=true`. The release preflight compares it against the reviewed Wrangler `hyperdrive` entries and readback checks the deployed IDs. Runtime rejects any missing or mismatched Binding. This alone **does not prove** source Hyperdrive configuration, CA trust, hostname validation, disabled query cache, pool restart, or rollback-version safety; these remain mandatory external verification gates before any Hyperdrive activation. No account-management token is embedded in the production Worker.

For MySQL Hyperdrive, the driver cannot use protocol-level prepared `execute()`. Structured writes use `query(sql, params)` only for primitive values and verify `NO_BACKSLASH_ESCAPES` is absent from the **same transaction/session immediately before interpolation**. This is **not a server-side parameter binding**, and deployed Workers escaping/injection/rollback tests remain P0 requirements. PostgreSQL Hyperdrive must respect transaction pooling. Never retry ambiguous non-idempotent commits.

The existing MCP tools remain: `list_connections`, `inspect_schema`, `get_schema_context`, `query_read`, `explain`, `health_check`, `insert_rows`, `update_rows`, `delete_rows`, `create_table`, `alter_table`, `create_index`, `drop_index`, `drop_table`. Existing row, result-byte, query-time and write-affected-row limits remain.

## Security and release checks

Direct validates all returned DNS A/AAAA addresses as public and pins a validated address for each TCP connection attempt, while keeping the original hostname as the immutable logical target. This removes the second DNS lookup during a single Direct connection; it does **not** provide TLS peer authentication, prevent legitimate DNS changes between invocations, or guarantee every public address belongs to the intended server. Never use Direct with a server requiring encrypted database traffic. PostgreSQL user-provided read/EXPLAIN queries run within a short native READ ONLY transaction; the scanner also blocks known side-effecting functions. MySQL read access continues to depend on explicit database-native least-privilege grants (and the SQL guard); no blacklist can classify arbitrary user-defined routines. Database GRANT/RLS and transactional engine properties remain the authorization and rollback boundaries.

The Worker requires `MCP_ACCESS_TOKEN`, `DATABASE_ENCRYPTION_KEY`, `DATABASE_KEY_ID`, `DATABASE_GITHUB_ACTIONS_TOKEN`, a dedicated D1 `DB` binding, `RATE_LIMITER`, `SETUP_RATE_LIMITER`, and the existing Owner Access Variables. Bounded CAS key rotation applies **only to encrypted Direct records**; retained rollback versions and backups must be compatible with both current and historic encryption keys.

For subsequent releases use only existing protected GitHub Actions with read-only D1/Access/binding gates and exact active-version checks; the old importer and legacy rollback dispatch are retired. For a sensitive Hyperdrive Cloudflare change: disable the logical connection, change the dedicated upstream config with approved access, restart/drain its native pool, verify **new connections** and TLS/caching/binding provenance, then explicitly enable. Failures remain disabled. To retire a Hyperdrive record, first disable it, review older rollback-version and external consumers, remove its Binding and manifest entry in a reviewed GitHub release, verify that release in production, then dispatch the existing protected Release Worker with `database_hyperdrive_retire_approved`, exact ID and revision. The guarded job verifies unbound current production, CAS-deletes only the disabled D1 record, and confirms permanent ID retirement; it never deletes Cloudflare config/CA. The Owner separately reviews old versions, other consumers and CA dependencies before any upstream resource deletion. Do not add auto-cleanup or another orchestrator.

```bash
pnpm --filter database-mcp-worker check
node --test scripts/manual-worker-release.test.mjs
```

Unit tests and dry-run are not deployed Workers acceptance. MySQL Direct and MySQL Hyperdrive have separate production E2E evidence. No PostgreSQL Hyperdrive connection is currently configured, and PostgreSQL Direct lacks an accepted plaintext origin; neither has current runtime E2E evidence. The now-retired Aiven test hosts previously passed origin-side CA and hostname negatives, which do not replace deployed Workers TLS-negative acceptance on current origins. Real production writes and DDL were exercised only against a dedicated test table and cleaned up; no authorization to modify existing business tables follows. See [production cutover and rollback](../../docs/database-cutover-344.md), [historical Direct TLS investigation](docs/direct-tls-feasibility.md), and [Spec #344](https://github.com/lirtual/mcp-workers/issues/344).

## License

MIT; upstream provenance retained in `LICENSE` and `SOURCE.md`.
