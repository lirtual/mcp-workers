# Database MCP Spec #344 — production cutover / rollback

**BLOCKED; this checklist is not production, D1 migration, credential, or Hyperdrive resource authorization.** The existing deployed Worker and its whole-catalog `DATABASE_CONFIG` Secret remain unchanged. Do not connect to or probe `scrape_relay` or `b2b` without separate express Owner approval.

## Preconditions (independent evidence)

1. **Release identity:** freeze the exact authorized `main` commit and the complete reviewed legacy ID→dialect→target inventory *offline*. Preserve a recoverable pre-cutover Worker, D1 snapshot, original Secret, encryption keys, and explicit rollback compatibility.
2. **D1:** apply reviewed **additive** `0002_transport_and_retired_ids.sql` using separately authorized D1 migration steps, leaving deployed `0001` and ledger unmodified. Verify both migrations, 0–10 slots, encrypted Direct records, null Hyperdrive credentials, CAS and retired-ID invariants. Previously active Direct records become disabled with incremented revisions to prevent silent TLS-to-plaintext downgrade; each requires a new explicit plaintext risk acknowledgment before enabling. Old legacy records must be authenticated against the frozen inventory without upstream SQL calls.
3. **Owner:** read back exact-domain Cloudflare Access OTP, JWT audience, Owner email, Origin/CSRF, session duration and negative tests. Verify no credentials or CA appear in source, Worker variables, logs or test artifacts.
4. **Direct:** obtain separately authorized, isolated **plaintext** MySQL and PostgreSQL fixtures. Confirm explicit risk consent, public endpoint filtering, health, read/schema/explain, Safe Write/rollback, controlled DDL, timeouts and injection/Host negatives. A TLS-only Aiven instance is **not** a Direct fixture.
5. **Hyperdrive:** prepare one dedicated Cloudflare configuration per connection, strictly verify real origin hostname and full CA chain (Postgres verify-full / MySQL VERIFY_IDENTITY), `caching.disabled=true`, quotas and credential ownership. Publish only the nonsecret config ID/Binding and approved origin/CA metadata through existing GitHub Actions, require Hyperdrive Read permission and verify pre/post-deploy Cloudflare API readback against the protected manifest and actual deployed bindings/config IDs, prove live read, Safe Write/rollback, controlled DDL and negative TLS/hostname/CA tests in **real Workers** for each dialect. MySQL `query(sql,params)` escaping and transaction/session SQL mode is P0; a Node mock or Aiven SELECT 1 alone cannot discharge it.
6. **Sensitive Hyperdrive changes:** disable with D1 CAS; update Cloudflare only during an authorized maintenance window; restart/drain its native connection pool; verify new-session target/auth/strict TLS/CA/cache and binding; manually re-enable. An interrupted or failed change stays disabled. Worker code rollback does not restore Cloudflare origin, CA, password or pooled state.
7. **Cutover:** obtain **fresh separate authorization** to touch the original two business DBs and perform migration. Every legacy identity must be accounted for and safely tested; no Aiven substitute, no silent transport change or ID reuse. Confirm successful /mcp and /setup against the actual production Worker, readback of version, D1 and Access, and rollback-safe keys before retiring the prior config path. Do not automatically delete the previous production Secret.

## Recovery rules

- A missing D1 migration, mismatched immutable manifest, unknown Hyperdrive ID, disabled legacy ID, unverified CA/hostname, failed MySQL escaping, inadequate pool restart or unresolved rollback reference blocks publication/activation. Never downgrade to Direct.
- Cloudflare config, Worker binding and D1 CAS writes are independent; no distributed transaction or automatic compensating saga. Failed partial sequences remain disabled with manual recovery.
- An old whole-D1 Time Travel restore **can lose retired IDs**. Freeze add/enable, reconcile against independently retained approved identity/retirement evidence before restoring service, and fail closed if any IDs cannot be accounted for.
- Retain previous encryption keys for all active and rollback-eligible Worker versions, D1 Time Travel and exported backups. A whole-D1 restore may also lose later connection changes: reconcile under Owner supervision.
- Deleting Hyperdrive means: disable → unbind through authorized protected release → independent live Worker readback → check rollback-eligible versions and other consumers → retire D1 row → only then consider removing dedicated config and CA; never automatically reclaim another service's resource.
- No new environment, Worker, monitor, proxy, credentials export, fork modification, secret deletion, or production write is authorized by this document.

Track actual four-path acceptance and each blocked gate in [Issue #344](https://github.com/lirtual/mcp-workers/issues/344). Leave Issue open and PR #345 Draft until explicit deliverable approval.

## Important cutover ordering guard

Migration `0002` disables every historical Direct row (preserving ciphertext, increasing revision). The read-only publish D1 gate accepts disabled rows **only** when the reviewed IDs and schema/ledger match. This does not authorize production cutover, nor does it mean that any old connection is safe to enable. After a separately authorized release and readback, the Owner must reconfigure any old TLS/CA connection for Direct plaintext and explicitly acknowledge plaintext risk before enabling. Production cutover requires the original separate approvals and tests.

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

**Status: Blocked, not executed.** The dedicated Aiven PostgreSQL service is
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

An authorized Aiven PostgreSQL administrator may execute **once** in the
**dedicated** `database-mcp-test-postgres` database. Run in the Aiven SQL
editor or another trusted administrator session; do not post any passwords
or connection URLs in GitHub or ChatGPT. This deliberately refuses
wrong database/user or a pre-existing schema and grants **only**
`USAGE, CREATE` on a dedicated new schema, not on `public`:

```sql
DO $db344_guard$
BEGIN
  IF current_database() <> 'database-mcp-test-postgres'
     OR current_user <> 'avnadmin' THEN
    RAISE EXCEPTION 'db344: wrong dedicated test database or administrator';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'test') THEN
    RAISE EXCEPTION 'db344: dedicated test role not present';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'db344_acceptance') THEN
    RAISE EXCEPTION 'db344: schema already exists; review manually';
  END IF;
  EXECUTE 'CREATE SCHEMA db344_acceptance';
  EXECUTE 'GRANT USAGE, CREATE ON SCHEMA db344_acceptance TO "test"';
END;
$db344_guard$;
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

**Cleanup** after the test is confirmed: the administrator reconnects to
the same dedicated test database and executes the following guarded cleanup.
It refuses a different database, user or schema owner, and uses `RESTRICT`
rather than `CASCADE`:

```sql
DO $db344_cleanup$
BEGIN
  IF current_database() <> 'database-mcp-test-postgres'
     OR current_user <> 'avnadmin' THEN
    RAISE EXCEPTION 'db344: wrong dedicated test database or administrator';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_namespace
    WHERE nspname = 'db344_acceptance'
      AND nspowner = (SELECT oid FROM pg_roles WHERE rolname = 'avnadmin')
  ) THEN
    RAISE EXCEPTION 'db344: schema absent or owned by another role';
  END IF;
  EXECUTE 'REVOKE CREATE, USAGE ON SCHEMA db344_acceptance FROM "test"';
  EXECUTE 'DROP SCHEMA db344_acceptance RESTRICT';
END;
$db344_cleanup$;
```

If any object remains, `RESTRICT` deliberately fails and the transaction
rolls back; investigate and remove **only** the isolated test objects first.
Do not drop unrelated schemas or grant privileges on `public`.
Independently confirm the disposable Hyperdrive, Worker and CA have been
deleted and the Draft PR's temporary workflow has been removed.
