# Database MCP Spec #344 — production cutover / rollback

## Current production evidence (2026-10-28)

One-time D1 preparation **completed** via GitHub Actions run #40651848593. Production D1 now has both reviewed migrations and exactly two **disabled, encrypted** MySQL Direct identities: `b2b` and `scrape_relay` (key ID `db344-20261028`). **Do not rerun the importer.** The deployed legacy Worker still serves both connections from its original `DATABASE_CONFIG` and has no D1 binding. The Owner waived an independent encryption-key backup: keep the existing key stable and preserve the original connection configuration; losing the key makes existing ciphertext irrecoverable.

**Release phase distinction (Draft PR only; no production action):** The first old-Worker → D1-Worker publication still requires exact `b2b` and `scrape_relay` rows, both authenticated against the approved legacy source at `active` revision 2, and an independently verified recoverable old version. A later D1-Worker → D1-Worker publication must **not** demand that the original two IDs remain active or even present: Owner setup can legitimately add, disable and retire connections within the 0–10 limit. The protected read-only release gate distinguishes phases using the *actual 100%-active Worker version* as well as the D1/legacy binding inventory, then verifies both D1 migrations, registry limits and retired-ID nonreuse, and authenticates every remaining Direct AES-GCM ciphertext using the current/retained recovery key. Unknown/mixed deployment versions and out-of-band first-cutover binding changes fail closed. This change **does not** implement the safety-blocked Direct D1 activation writer, run any rollback, authorize a release, modify D1 or prove Hyperdrive TLS negative tests.

**P0 production release block:** The new Worker rejects disabled connections. Its release preflight must require **all** reviewed legacy IDs to be active in D1, not merely present, before any new Worker publication. Today both are disabled, so publishing PR #345 would interrupt existing consumers. Direct enablement requires a separate controlled D1-only pre-cutover authorization, explicit plaintext-risk acceptance, and verified rollback before release. None of those operations is implicitly authorized by this PR. The approved preparation workflow cannot be rerun after successful import.

**Owner transport-risk decision (2026-10-28):** In direct response to the question whether `b2b` and `scrape_relay` may continue using MySQL Direct **without explicit TLS**, the Owner replied **“同意，继续推进”**. This is recorded narrowly as acceptance of continuing the existing unencrypted Direct transport during this cutover, **not** approval to enable the two D1 rows, merge PR #345, publish the new Worker, or access any additional business tables. Encryption of URLs **at rest in D1** does not secure the MySQL wire protocol. Do not broaden this risk decision to PostgreSQL, Hyperdrive, other identities or any TLS downgrade from a separately documented TLS-enabled source.

**Legacy recovery target, independently read-only verified (2026-10-28):** Cloudflare deployable-version API includes original Worker version `eb3f4823-124b-4d76-abdc-42f85097bb5a` (100% active in deployment `8af13de8-0fe0-4da2-a02b-63319cdd8932`). Its stored version bindings include `DATABASE_CONFIG` and `MCP_ACCESS_TOKEN` as Secrets plus `RATE_LIMITER`, and no `DB` D1 binding. The existing Release Worker workflow now includes a narrow **read-only prepublication old-version availability/bindings gate** (`scripts/database-legacy-restore-preflight-344.mjs`); this gate prevents publishing when the pinned old version becomes unavailable, but **it is not a live restore rehearsal**.

**Recovery execution (future, separate approval only):** Cloudflare officially supports rolling back to a specifically named Worker version (https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/); it immediately deploys that version to 100% traffic. Before relying on it, retain the old version and its unchanged Secrets, verify deployment permission and no incompatible resource changes, and obtain an independently authorized recovery action. **After any failed new-Worker publication, restore the old version and independently verify original Worker binding/health and both IDs first. Only afterward consider a separately approved, all-or-none D1 disable CAS.** Do not blindly re-run CAS after timeout; read back state. No restore has been performed in production, so live recovery remains **P0/Blocked**, and adding this read-only gate does not authorize deployment or D1 writes.

The remaining checklist is for a future separately approved cutover; older pre-preparation directions below are historical and must not be executed again.

**BLOCKED; this checklist is not production, D1 migration, credential, or Hyperdrive resource authorization.** The existing deployed Worker and its whole-catalog `DATABASE_CONFIG` Secret remain unchanged. Do not connect to or probe `scrape_relay` or `b2b` without separate express Owner approval.

## One-time protected D1 preparation (not a production cutover)

The reviewed `Release Worker` workflow on `main` now has a separate **database_prepare_approved** manual path for `database-mcp-worker` with **deploy_to_production=false**. It is deliberately mutually exclusive with Worker publishing and Hyperdrive activation. The path uses the existing protected `database-mcp-worker` GitHub Environment, serializes against Worker releases, checks the exact main SHA and Owner actor, and starts with a read-only preflight.

Reuse the existing `DATABASE_CONFIG` **GitHub Environment Secret** if it is already configured for `database-mcp-worker`; do not introduce a second alias. This must be the exact authorized original legacy JSON map containing **only** `scrape_relay` and `b2b`. If the value exists only as a Cloudflare Worker Secret, it cannot be read back through the Cloudflare API: obtain it from the trusted original source and securely populate the same-name GitHub Environment Secret. Do **not** send or paste it into ChatGPT, git, workflow inputs, logs, issues, or artifacts. The importer cannot independently prove that a manually supplied map equals the deployed Secret, so Owner identity/target attestation is required before dispatch. If the original value cannot be obtained safely, stop.

Other prerequisites: Environment Secrets `DATABASE_ENCRYPTION_KEY` (canonical Base64 32 bytes) and existing `CLOUDFLARE_API_TOKEN`; Environment Variable `DATABASE_KEY_ID` (approved stable, non-secret key identifier), plus the existing `CLOUDFLARE_ACCOUNT_ID` Variable. The original `b2b` and `scrape_relay` identities are fixed in the reviewed release gate; no additional ID Variable is required. **Owner-approved waiver (2026-10-28):** no independent key backup is required. Keep the GitHub Environment `DATABASE_ENCRYPTION_KEY` value and `DATABASE_KEY_ID` unchanged; loss/rotation makes old D1 ciphertext irrecoverable, requiring original connection configuration for a fresh import. Do not delete the legacy `DATABASE_CONFIG` while it is needed for continuity. No secret values should enter the source tree. The current deployed Worker continues to use `DATABASE_CONFIG` throughout preparation.

The protected flow first validates source/input/key, and confirms D1 `0001` present, `0002` absent and registry empty. It then uses **Wrangler's normal D1 migration ledger** to apply only reviewed additive migrations; the existing script encrypts the two URLs with AES-256-GCM and AAD bound to ID/dialect, inserts both disabled records in one SQLite INSERT, and reads back their nonsecret identities, modes, revisions, and ciphertext lengths. Every failure stops without publishing the Worker or enabling the connections. If the migration succeeds and the import fails, **leave the old production Worker unchanged** and recover/reconcile manually; never retry blindly or forge migration records.

**Important:** This preparatory step does not prove either re-enabled Direct connection, nor authorize a legacy TLS-to-plaintext change. The two D1 records are initially `disabled`; even after successful preparation, a release would intentionally break old consumers unless a separately approved and verified enablement/cutover sequence proves both identities, keys, routes, and rollback. Keep PR #345 Draft and do not dispatch this production preparation until the required Environment Secrets and explicit production migration authorization have been independently verified.

## Preconditions (independent evidence)

1. **Release identity:** freeze the exact authorized `main` commit and the complete reviewed legacy ID→dialect→target inventory *offline*. Preserve a recoverable pre-cutover Worker, D1 snapshot, original Secret, encryption keys, and explicit rollback compatibility.
2. **D1:** apply reviewed **additive** `0002_transport_and_retired_ids.sql` using separately authorized D1 migration steps, leaving deployed `0001` and ledger unmodified. Verify both migrations, 0–10 slots, encrypted Direct records, null Hyperdrive credentials, CAS and retired-ID invariants. Previously active Direct records become disabled with incremented revisions to prevent silent TLS-to-plaintext downgrade; each requires a new explicit plaintext risk acknowledgment before enabling. Old legacy records must be authenticated against the frozen inventory without upstream SQL calls.
3. **Owner:** read back exact-domain Cloudflare Access OTP, JWT audience, Owner email, Origin/CSRF, session duration and negative tests. Verify no credentials or CA appear in source, Worker variables, logs or test artifacts.
4. **Direct:** obtain separately authorized, isolated **plaintext** MySQL and PostgreSQL fixtures. Confirm explicit risk consent, public endpoint filtering, health, read/schema/explain, Safe Write/rollback, controlled DDL, timeouts and injection/Host negatives. A TLS-only Aiven instance is **not** a Direct fixture.
5. **Hyperdrive:** prepare one dedicated Cloudflare configuration per connection, strictly verify real origin hostname and full CA chain (Postgres verify-full / MySQL VERIFY_IDENTITY), `caching.disabled=true`, quotas and credential ownership. Publish only the nonsecret config ID/Binding and approved origin/CA metadata through existing GitHub Actions, require Hyperdrive Read permission and verify pre/post-deploy Cloudflare API readback against the protected manifest and actual deployed bindings/config IDs, prove live read, Safe Write/rollback, controlled DDL and negative TLS/hostname/CA tests in **real Workers** for each dialect. MySQL `query(sql,params)` escaping and transaction/session SQL mode is P0; a Node mock or Aiven SELECT 1 alone cannot discharge it.
6. **Activation gate:** The Owner page rejects Hyperdrive `POST /setup/enable`. Only the separately approved Owner-triggered activation operation in the existing protected Release Worker Actions workflow may check the exact reviewed main/source, deployed Binding/D1, Cloudflare TLS/CA/origin/cache, CAS-enable the disabled row, and perform a bounded live MCP health check with fail-closed CAS-disable on failure. Cross-system activation is not atomic and unauthorized out-of-band Cloudflare changes remain forbidden; this document alone grants no activation authorization.
7. **Sensitive Hyperdrive changes:** disable with D1 CAS; update Cloudflare only during an authorized maintenance window; restart/drain its native connection pool; verify new-session target/auth/strict TLS/CA/cache and binding; manually re-enable. An interrupted or failed change stays disabled. Worker code rollback does not restore Cloudflare origin, CA, password or pooled state.
7. **Cutover:** obtain **fresh separate authorization** to touch the original two business DBs and perform migration. Every legacy identity must be accounted for and safely tested; no Aiven substitute, no silent transport change or ID reuse. Confirm successful /mcp and /setup against the actual production Worker, readback of version, D1 and Access, and rollback-safe keys before retiring the prior config path. Do not automatically delete the previous production Secret.

## Recovery rules

- A missing D1 migration, mismatched immutable manifest, unknown Hyperdrive ID, disabled legacy ID, unverified CA/hostname, failed MySQL escaping, inadequate pool restart or unresolved rollback reference blocks publication/activation. Never downgrade to Direct.
- Cloudflare config, Worker binding and D1 CAS writes are independent; no distributed transaction or automatic compensating saga. Failed partial sequences remain disabled with manual recovery.
- An old whole-D1 Time Travel restore **can lose retired IDs**. Freeze add/enable, reconcile against independently retained approved identity/retirement evidence before restoring service, and fail closed if any IDs cannot be accounted for.
- Retain previous encryption keys for all active and rollback-eligible Worker versions, D1 Time Travel and exported backups. A whole-D1 restore may also lose later connection changes: reconcile under Owner supervision.
- Deleting Hyperdrive means: disable → unbind through authorized protected release → independent live Worker readback → check rollback-eligible versions and other consumers → retire D1 row → only then consider removing dedicated config and CA; never automatically reclaim another service's resource.
- No new environment, Worker, monitor, proxy, credentials export, fork modification, secret deletion, or production write is authorized by this document.

Track actual four-path acceptance and each blocked gate in [Issue #344](https://github.com/lirtual/mcp-workers/issues/344). Leave Issue open and PR #345 Draft until explicit deliverable approval.

## Direct cutover implementation acceptance contract (review only; no production execution)

The current standalone D1 preparation is already complete and **must not be rerun**. Before introducing a Direct activation path in the existing manual Release Worker workflow, its reviewer must require the following fail-closed controls. This is a design/review checklist, not permission to run any D1 mutation:

1. Owner-only manual approval on the exact reviewed main SHA, GitHub Environment `database-mcp-worker`, same existing release concurrency lock, `deploy_to_production=false`, and mutual exclusion with Hyperdrive activation and preparation inputs. A normal Worker publish must refuse any Direct activation approval flag.
2. Before writing, read only the deployed old Worker binding inventory (original `DATABASE_CONFIG` present; new D1 binding absent), the dedicated D1 migration ledger, exactly two unretired rows, current revisions and statuses, and the approved original GitHub Environment source. Verify AES-256-GCM authentication and exact-match **both** decrypted Direct URLs against the original approved inventory **without printing or persisting plaintext**. GitHub's copied Secret alone does not prove equality with the deployed, non-readable Cloudflare Secret; secure Owner attestation or independent comparison remains a required precondition.
3. Direct plaintext transport requires a **separate explicit Owner acceptance**; a previously verified TLS transport must never be silently downgraded. Exact previous connection transport/endpoint identity and required reachable public-host rules must be reviewed before enablement. No upstream SQL or connectivity probe belongs in the D1-only stage.
4. In one D1 transaction, perform a revision-checked all-or-nothing state transition for exactly `b2b` and `scrape_relay`, and only from both expected `disabled` revisions. Guard against stale concurrent writes and check exactly two affected rows. Re-read non-sensitive metadata. A lost acknowledgement must trigger **read-only reconciliation**, not a blind retry; never assume atomicity between D1 and a later Worker publication.
5. Ensure an independently reviewed rollback path can restore the original Worker without changing its legacy Secret and, when necessary, CAS-disable newly enabled D1 rows. Do not delete or regenerate `DATABASE_ENCRYPTION_KEY`; per Owner decision no independent key backup exists. If a pre-release validation or readback fails, stop with the old Worker unchanged. A later Worker publish is a new independent approval with its own no-outage/read-only acceptance.

**Offline implementation evidence:** `scripts/database-direct-transition-contract-344.mjs` now constructs an authenticated, fully parameterized, **single-statement** SQLite two-row compare-and-swap. Its SQLite integration tests prove all-or-none transition from revision 1 to revision 2 and reject altered ciphertext, stale revisions, unexpected rows, retirement state, and repeat attempts. It **does not execute SQL** or expose a runnable production activation action. A separate read-only pre-publication guard in the existing Release Worker workflow now rechecks that both approved Direct identities are **active at revision 2** and that authenticated ciphertext still decrypts to the reviewed source URLs. A mismatch fails before any new Worker publication; original old Worker and `DATABASE_CONFIG` stay unchanged. The Cloudflare-to-GitHub original Secret equality caveat and explicit plaintext-transport consent remain separate prerequisites. SQLite tests do not themselves prove Cloudflare D1 run-time behavior or approve production writes.

**Offline rollback acceptance (2026-10-28):** `prepareDirectRollbackStatement` is now included in the same offline-only transition contract. It authenticates exactly both `active`, revision-2 Direct ciphertexts with the approved original URLs and generates one all-or-none, parameterized SQLite CAS to `disabled` revision 3. The six combined local SQLite activation/rollback tests cover normal activation, reverse transition, replay rejection and stale revision/identity/key/ciphertext/retirement/extra-row refusal. **It does not execute D1 SQL or provide an executable production rollback route.**

**Rollback ordering is mandatory:** Before any *post-publication* D1 rollback, independently restore and verify the actual old Worker version with its original `DATABASE_CONFIG` and healthy original connections; only then may a separately approved D1-only two-row disabling transaction be considered. Disabling both while the new D1-only Worker still serves requests would interrupt both connections. Before any Worker release, verify a practical, authorized restoration path and its actual source/version/binding readiness; a Cloudflare version listing alone is not rollback execution evidence. A lost CAS acknowledgement requires **read-only state reconciliation**, never blind re-execution. Cloudflare production read-only version inventory at review showed one existing active legacy version `eb3f4823-124b-4d76-abdc-42f85097bb5a` at 100% (deployment `8af13de8-0fe0-4da2-a02b-63319cdd8932`); this does **not** prove it can be restored after a future new publication. The existing GitHub Actions Worker release workflow has no independently verified rollback operation. Therefore **live rollback remains a separate P0 gate**, even though the offline SQL behavior is validated.

**Implementation state:** no reviewed Direct activation dispatch/job is currently present. The earlier attempt to add one was blocked by the environment's safety checks and was not committed. Do not bypass this by direct Cloudflare D1 write requests or by reusing the Hyperdrive-only activation job. Existing PR #345 stays Draft while this P0 condition is unresolved.

## Important cutover ordering guard

Migration `0002` leaves historical Direct rows disabled. **The current release D1 gate rejects any disabled reviewed legacy ID**; publishing the new D1-only Worker first would interrupt existing connections. The old Worker stays published while a separately authorized, reviewed D1-only operation prepares both Direct identities. Only after the two identities are active, their original encrypted URLs have been matched to the approved inventory, the Owner explicitly accepts the plaintext Direct transport risk, and rollback has been verified may a *separately approved* Worker release be considered. Existing Hyperdrive-only activation does not authorize Direct enablement; the proposed Direct write path is not yet implemented or approved.

## Local integration evidence (not Cloudflare)

Disposable PostgreSQL 17 and MySQL 8.0 Docker fixtures exercised the existing SQL integration suite (Direct health/read, privilege/RLS, Safe Write rollback/limits, and structured DDL). A separate MySQL adapter test deliberately simulates the Hyperdrive *Worker→proxy* path by using a local plaintext MySQL server and validates transaction-pinned SQL mode, client-side SQL escaping and injection rejection. It does **not** validate the Hyperdrive→origin TLS chain, actual Worker binding, pool restart or real Cloudflare MySQL behavior; those remain pending.

## 2026-10-28 isolated acceptance evidence (no production cutover)

- Reused the existing protected GitHub Actions one-time smoke workflow, **run 40529759928**, successful rerun. A temporary bearer-gated Worker connected to the two dedicated Aiven test services through Cloudflare Hyperdrive with PostgreSQL `verify-full` and MySQL `VERIFY_IDENTITY`, explicit CA ID `c9a71de0-06b0-4ea2-b2e8-2dfc27fb0d7a` and caching disabled. Both `SELECT 1` and database-side TLS session checks returned true. This is real Worker/Hyperdrive smoke proof, **not** full read/write/DDL proof for this PR.
- Separately checked the Aiven dedicated test endpoints using the locally existing project CA and OpenSSL: correct chain and hostname were accepted for PostgreSQL and MySQL; wrong CA and wrong hostname were rejected for each. These are independent TLS client checks, **not** a claim that Hyperdrive itself rejected those negative cases.
- The one-time workflow deleted both Hyperdrive configs. A separate read-only Cloudflare API query proved zero Hyperdrive configs, zero temporary `db344-` Workers and zero certificate associations. The test CA uploaded for this rerun was then deleted after reference checks; no additional persistent Cloudflare test resource remains.
- Disposable local PostgreSQL 17/MySQL 8.0 database fixtures passed **22/22** integration cases, including Direct SQL tools and a clearly labeled simulated Worker→Hyperdrive MySQL adapter; neither is a deployed four-mode acceptance.
- This local worktree passed **97/97** app unit tests, **46/46** release/readback tests, TypeScript, ESLint, Wrangler dry-run, and `git diff --check` after switching the Hyperdrive runtime adapter to Cloudflare's structured host/user/password/database/port binding fields.
- **Remaining blocking evidence:** run the actual new Database MCP Worker in an isolated Cloudflare test with safe read/schema/explain, Safe Write, rollback and controlled DDL for both Hyperdrive dialects; independently test Hyperdrive wrong-CA/hostname, MySQL session mode, credential update+pool restart, rollback-compatible bindings and key/D1 restore. Do not treat passing smoke or isolated tests as authorization for PR merge, migrations, any original business database contact or a production Worker release.

## 2026-10-28 full-core Hyperdrive acceptance: recorded failures (P0 blocked)

- Temporary one-time workflow `database-hyperdrive-once-344.yml` was reused on the isolated Draft PR branch, not published to main or production. The disposable test Worker imported the current Database MCP SQL core to exercise Health, read, EXPLAIN, schema, structured DDL, Safe Write and rollback against **only** the dedicated Aiven test PostgreSQL and MySQL. Workflow runs [40614905580](https://github.com/lirtual/mcp-workers/actions/runs/40614905580), [40615110341](https://github.com/lirtual/mcp-workers/actions/runs/40615110341), [40615296102](https://github.com/lirtual/mcp-workers/actions/runs/40615296102) and [40615460733](https://github.com/lirtual/mcp-workers/actions/runs/40615460733) failed at the expected P0 barriers; they do not count as acceptance passes.
- **PostgreSQL:** the core health, safe read and EXPLAIN steps completed; `create_table` returned the safe `ACCESS_DENIED` error for the existing dedicated Aiven `test` database account. No permission escalation or production database write was performed. Other SQL/DDL/rollback steps past this point remain **Blocked**, not Pass.
- **MySQL:** the core health fails closed with `CONFIGURATION_UNAVAILABLE` before any writes. A restricted Worker diagnostic of the same transaction-mode check returned `rowsArray=true`, `rowsHaveOne=false` (empty result set), `modeIsString=false` and `forbiddenBackslashMode=false`. This does **not** prove the SQL mode is safe or unsafe, merely that it is not verifiable through the current Hyperdrive result path. Do not disable the in-transaction SQL-mode gate, fall back to unsafe MySQL escaping or count the earlier `SELECT 1` smoke as Safe Write acceptance.
- Every run's temporary Hyperdrive configs and Worker were deleted. A separate Cloudflare API readback confirmed zero Hyperdrive configs, zero temporary Workers, zero CA associations; the temporary, uniquely named test CA was deleted after these checks. No permanent test environment, workflow or second CI was retained.
- Future full four-mode acceptance requires a properly authorized isolated PostgreSQL role with controlled DDL privileges, and a verifiable MySQL Hyperdrive session-mode result (or another separately approved safety-equivalent design) before Safe Write. Fix these P0s before merge or production; keep PR Draft and Issue Open. GitGuardian's pre-existing OpenList test fixture alert remains a separate unresolved check and has not been waived.

### Origin principal identity readback
Hyperdrive binding manifest entries must also declare the **nonsecret** `origin_user` value. The protected release gate verifies that Cloudflare's returned `origin.user` equals this reviewed principal, in addition to hostname, port, database, CA and strict TLS mode. This prevents a privileged-user substitution from passing readback. Never put passwords or connection URLs in the manifest, logs or Issue.

## 2026-10-28 follow-up: real Hyperdrive root-cause isolation

- [Run #40616411953](https://github.com/lirtual/mcp-workers/actions/runs/40616411953): After one transient Cloudflare create error 2015, the successful rerun proved `SHOW SESSION VARIABLES LIKE 'sql_mode'` returns one correctly typed result in both transaction and autocommit, with mysql2 array and object row modes. `SELECT @@SESSION.sql_mode` returned zero rows via Hyperdrive, so the MySQL core now uses the SHOW variant **inside the same pinned transaction**. The check remains fail-closed for missing/ambiguous values or `NO_BACKSLASH_ESCAPES`.
- [Run #40616904677](https://github.com/lirtual/mcp-workers/actions/runs/40616904677): PostgreSQL passed isolated Worker TLS, Health, Read, EXPLAIN and Schema. MySQL passed those same operations after the change, but its structured `CREATE TABLE` failed with public `DATABASE_ERROR`. Neither dialect's full DDL/Safe Write acceptance has passed.
- [Run #40617497626](https://github.com/lirtual/mcp-workers/actions/runs/40617497626): A read-only probe proved PostgreSQL `has_database_privilege(...,'CREATE')=false`, `has_schema_privilege(...,'public','CREATE')=false`, `TEMP=true`. MySQL grants include CREATE in the dedicated test service. `db344_`-prefixed table count was zero.
- [Run #40617660857](https://github.com/lirtual/mcp-workers/actions/runs/40617660857): An isolated, generated, **database-qualified** MySQL CREATE TABLE statement failed with native `ER_BAD_DB_ERROR` / 1049 / SQLSTATE 42000; cleanup returned success. Error messages, credentials and SQL contents were not logged.
- [Run #40617895122](https://github.com/lirtual/mcp-workers/actions/runs/40617895122): A minimal comparison against the same dedicated Aiven MySQL service reconfirmed qualified CREATE fails with 1049, whereas **unqualified CREATE succeeded and was dropped successfully**. However, the referenced database name was not confirmed by `SHOW DATABASES LIKE`, so unqualified DDL is **not an acceptable fix**: the default schema might differ from the approved database. Both test table cleanup calls succeeded. Cloudflare Hyperdrive configs and temporary Workers were independently confirmed absent, and the test CA was removed after checking zero live associations.
- **P0 remains:** reconcile the real MySQL default schema, configured origin database and release manifest identity before any structured writes; do not loosen the MySQL schema restriction or silently remove qualifiers. PostgreSQL's isolated DDL test role requires separately provisioned narrowly scoped CREATE rights. A full live Safe Write/rollback/DDL pass for both dialects remains Blocked. Cloudflare creation returned sporadic 2015 generic failures (no conclusion about root cause). None of these tests authorized production migration, binding enablement, PR merge or release.

## 2026-10-28 definitive MySQL schema identity resolution and PG permission readback

- The earlier interpretation that the dedicated MySQL database did not exist was **disproved** by [real Worker run 40619486995](https://github.com/lirtual/mcp-workers/actions/runs/40619486995). `SHOW DATABASES`, `information_schema.schemata` and `SELECT DATABASE()` confirmed the reviewed `database-mcp-test-mysql` schema exists and is the selected origin database. **Cloudflare's runtime `HyperdriveBinding.database` differs from that schema**: it is the database field for the **Worker-to-Hyperdrive proxy handshake**, not a trusted SQL identifier for the origin database.
- Fixed `EffectiveConnection` to keep optional `proxyDatabase` (Hyperdrive client handshake only) separate from `database` (the reviewed MySQL origin schema). In MySQL Hyperdrive admission, resolve the schema exclusively from the static `origin_database` manifest field; reject missing/invalid values. The mysql2 driver continues connecting with Cloudflare's runtime `proxyDatabase`. Direct and PostgreSQL connections retain their prior behavior. The protected release readback separately compares `origin_database` and `origin_user` with the real Cloudflare origin.
- [Real Worker/Hyperdrive run 40619969144](https://github.com/lirtual/mcp-workers/actions/runs/40619969144) passed all **11/11 isolated MySQL acceptance checks**: strict origin TLS, Health, query, Read, EXPLAIN, Schema, structured table/index/alter DDL, parameterized INSERT with reserved characters, over-limit UPDATE rollback and persisted-value verification, bounded UPDATE and DELETE. This real acceptance used the current SQL core and the origin-schema/proxy-database separation helper; it is not a production binding deployment or a blanket production-acceptance claim.
- [Read-only run 40620251325](https://github.com/lirtual/mcp-workers/actions/runs/40620251325) found **zero** non-system PostgreSQL schemas with CREATE privileges for the isolated `test` role (one ordinary schema visible), so PostgreSQL persistent DDL remains **Blocked** pending narrowly scoped isolated test privileges. The same independent live read found **zero `db344_` MySQL test tables**. Both temporary Hyperdrive configurations and the Worker were removed; the temporary CA was subsequently deleted following Cloudflare API verification of no associations, no Hyperdrive configurations and no temporary Workers.
- This resolves the MySQL schema-mismatch and MySQL SQL-mode blockers. It does **not** authorize replacing the empty production `hyperdrive-bindings.json`, merging Draft PR #345, migrating production D1, touching `scrape_relay`/`b2b`, or releasing the production Worker. PostgreSQL full DDL/Safe Write/rollback and final cutover remain pending.

## PostgreSQL isolated DDL gate — least privilege operator handoff (2026-10-28)

**Historical status at preparation: Blocked, not executed.** This permission gate
was subsequently satisfied by the administrator; see the live acceptance record
below. The dedicated Aiven PostgreSQL service is
`postgresql-zeroverse.d.aivencloud.com:18691`, database
`database-mcp-test-postgres`, database role `test`. The authenticated
role lacks `CREATE` on the database and on all visible non-system schemas.
[Read-only proof #40620251325](https://github.com/lirtual/mcp-workers/actions/runs/40620251325).
No authorized administrator credential or Aiven management connection is available
to this implementation session. The two available GitHub secrets authenticate
only the dedicated `test` roles; the Database connector exposes only
`scrape_relay` and `b2b`, which must never be used for this acceptance.
Do **not** attempt to upgrade the test role, use an old password, or touch
any business database.

An authorized Aiven PostgreSQL administrator may provision the schema **once**
in the **dedicated** `database-mcp-test-postgres` database. Never post passwords
or connection URLs in GitHub or ChatGPT.

**Aiven editor compatibility:** The SQL editor may split statements at
semicolons inside a PostgreSQL `DO $tag$ ... $tag$` block, yielding
`unterminated dollar-quoted string`. Execute each of these ordinary SQL
code blocks **separately** instead. This variant requires an operator to
verify the preflight result **before** any DDL; it is not one atomic SQL guard.

1. Read-only preflight. Expected: exact database, `avnadmin`, false, true:

```sql
SELECT current_database() AS database_name,
       current_user AS login_role,
       EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='db344_acceptance') AS schema_exists,
       EXISTS(SELECT 1 FROM pg_roles WHERE rolname='test') AS test_role_exists
```

2. Only if **all four** preflight values match, create the isolated schema.
   Never use `IF NOT EXISTS`, which can hide a conflicting owner:

```sql
CREATE SCHEMA db344_acceptance AUTHORIZATION avnadmin
```

3. Grant exactly the required scope, not database-level or `public` privileges:

```sql
GRANT USAGE, CREATE ON SCHEMA db344_acceptance TO "test"
```

4. Independently verify all five fields are `true` before the test:

```sql
SELECT current_database() = 'database-mcp-test-postgres' AS database_ok,
       current_user = 'avnadmin' AS administrator_ok,
       EXISTS (
         SELECT 1 FROM pg_namespace
         WHERE nspname='db344_acceptance'
           AND nspowner=(SELECT oid FROM pg_roles WHERE rolname='avnadmin')
       ) AS schema_owner_ok,
       has_schema_privilege('test', 'db344_acceptance', 'USAGE') AS usage_ok,
       has_schema_privilege('test', 'db344_acceptance', 'CREATE') AS create_ok
```

Read-only permission verification, **as role `test` connected to the dedicated
test database**, must yield three `true` values, with
`pg_has_role`/other broader privilege changes neither required nor allowed:

```sql
SELECT current_database() = 'database-mcp-test-postgres' AS approved_database,
       has_schema_privilege(current_user, 'db344_acceptance', 'USAGE') AS can_use,
       has_schema_privilege(current_user, 'db344_acceptance', 'CREATE') AS can_create;
```

After verification, reuse the already established **one-time temporary** GitHub
Actions / Cloudflare Hyperdrive test path from this Draft PR's history and
set its PostgreSQL DDL schema parameter to `db344_acceptance` (never
`public`). Test Health, Read, EXPLAIN, Schema, structured CREATE/ALTER/index,
INSERT, bounded UPDATE/DELETE, over-limit rollback and final table cleanup.
Retain real run IDs and exact pass/fail phase markers. No permanent workflow,
Acceptance environment, production binding, production migration or wider
permissions may be introduced.

**Cleanup** only after successful acceptance tests and confirmed removal of
all their test objects. Using the same Aiven SQL editor, perform **separate**
queries. Because the editor may split dollar-quoted blocks, this is an
operator-verified sequence rather than an atomic server-side guard.

First require all three values to be `true`; otherwise stop:

```sql
SELECT current_database() = 'database-mcp-test-postgres' AS database_ok,
       current_user = 'avnadmin' AS administrator_ok,
       EXISTS (
         SELECT 1 FROM pg_namespace
         WHERE nspname='db344_acceptance'
           AND nspowner=(SELECT oid FROM pg_roles WHERE rolname='avnadmin')
       ) AS schema_owner_ok
```

Only after these checks pass, run this statement by itself:

```sql
DROP SCHEMA db344_acceptance RESTRICT
```

Dropping the dedicated schema also removes its role grants. If objects
remain, `RESTRICT` fails rather than deleting objects by cascade.
Never use `CASCADE` or operate on any other database/schema.

If the command fails because objects remain, investigate and remove **only**
the isolated test objects before attempting cleanup again.
Independently confirm the disposable Hyperdrive, Worker and CA have been
deleted and the Draft PR's temporary workflow has been removed.


## 2026-10-28 PostgreSQL Hyperdrive real DDL / Safe Write acceptance

- The authorized administrator independently confirmed the existing test schema
  `db344_acceptance` belongs to `avnadmin` and the dedicated `test`
  role has `USAGE` and `CREATE` on **only that schema**. No production
  credential, business database, or privilege escalation was used.
- [One-time real Worker run #40624927834](https://github.com/lirtual/mcp-workers/actions/runs/40624927834)
  succeeded with **13/13** true checks: approved test database, user and
  schema ownership/permissions verified from the authenticated Postgres
  connection; strict Hyperdrive origin TLS; Health, Read, EXPLAIN and Schema;
  generated CREATE TABLE, indexes, ALTER TABLE; bounded INSERT, UPDATE and
  DELETE; over-limit UPDATE rollback with persisted-value readback; and
  post-test table deletion plus independent PostgreSQL catalog check.
  Test SQL was strictly schema-qualified to `db344_acceptance`, never
  `public`. The private disposable table was cleaned, and the run used
  the current application SQL core, not an unrelated demonstration query.
- The disposable Worker and Hyperdrive configuration were deleted in the
  GitHub Actions `always()` cleanup, with Hyperdrive DELETE HTTP 200.
  Cloudflare readback showed no temporary configs/Workers or CA associations
  before the disposable CA was deleted (API HTTP 200); the final readback
  is recorded separately. The one-time workflow must not persist in the
  reviewed PR tip.
- Combined real Hyperdrive core evidence: PostgreSQL **13/13** and MySQL
  **11/11**. These are real isolated Hyperdrive read/DDL/write/rollback
  proofs, not blanket approval for Direct plaintext transport, origin TLS
  negative cases, release-binding setup, production D1 cutover or Worker
  deployment. Previous no-permission PostgreSQL blockers are now resolved.
- **Post-test isolated Schema cleanup:** on 2026-10-28 the authorized
  administrator reported completing the previously documented
  `DROP SCHEMA db344_acceptance RESTRICT` in the dedicated Aiven PostgreSQL
  test database. This is **operator-confirmed**, not independently re-read
  using the isolated `test` credentials in this final review. Do not claim
  a fresh SQL absence check or retain the permission grant as active
  without verification. The full cleanup query remains above for audit.
- Spec #344 and PR #345 remain Open/Draft. The empty production
  `hyperdrive-bindings.json` manifest is deliberate. Existing GitGuardian
  findings require separate resolution; no check waiver, merge,
  production deploy, migration, Fork changes, or restricted DB operations
  are authorized by this acceptance.
