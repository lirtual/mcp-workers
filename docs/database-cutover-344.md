# Database MCP #344 — production release and recovery (managed D1 only)

## Latest verified state and TLS acceptance boundary (2026-10-30)

This section supersedes the historical snapshots below. Independently checked against
live Database MCP, Cloudflare Hyperdrive and the existing GitHub Actions CI:

- Production Worker version `b016569e-dbc8-4cc1-9aa6-fc91efae967f` serves **100%**.
  The two reviewed Hyperdrive configs are PostgreSQL
  `eb4ccbd231ea44beabc72b3f2b483d69` (`verify-full`) and isolated
  MySQL `38bf39b569484dbb8a9fe1b24f0df854` (`VERIFY_IDENTITY`).
  Both have an approved CA and query caching **disabled**.
- D1 logical connection inventory: `db344_pg_e2e`, `b2b` and
  `scrape_relay` are **active**; `aiven_mysql_e2e` and legacy
  `aiven_mysql_openlist` are **disabled**. Do **not** reactivate a test
  reference solely to recreate historical acceptance results. PostgreSQL
  `db344_pg_e2e` health **PASS**.
- Real isolated PostgreSQL Hyperdrive SQL/read, structured DDL/DML,
  RLS policy enforcement (including denied tenant access), 21-row
  UPDATE/DELETE transaction rollback and full test-table cleanup
  **PASS**. See [RLS](https://github.com/lirtual/mcp-workers/issues/344#issuecomment-6514431922)
  and [rollback](https://github.com/lirtual/mcp-workers/issues/344#issuecomment-6514478063).
  All synthetic test tables and RLS policies were cleaned up.
- Independent OpenSSL **origin** TLS handshake matrix on real Aiven
  PostgreSQL/MySQL was **6/6 PASS** (valid CA+hostname, bad CA rejection,
  bad hostname rejection): [evidence](https://github.com/lirtual/mcp-workers/issues/344#issuecomment-6514521721).
  This is **not** a deliberately misconfigured **Cloudflare Hyperdrive**
  handshake. The actual Hyperdrive-client bad-CA/bad-hostname negative
  test remains **NOT PERFORMED / BLOCKED**.
- The Cloudflare Hyperdrive API inventory has no separate read-only
  handshake-test endpoint. The supported create/update path tests an
  upstream connection but changes resources and requires an origin
  password. An attempted **isolated create** was blocked by platform
  safety controls; no alternate execution route or retry may be used
  to bypass this. Existing live configurations **must not** be modified
  to induce failure. See [blocker](https://github.com/lirtual/mcp-workers/issues/344#issuecomment-6514561715).
- Existing [PR #523](https://github.com/lirtual/mcp-workers/pull/523)
  adds the existing strict TLS/config drift regression suite to the
  existing mandatory CI. Both [PR CI](https://github.com/lirtual/mcp-workers/actions/runs/41000198731)
  and [merged main CI](https://github.com/lirtual/mcp-workers/actions/runs/41000595512)
  **PASS**. Offline tests are not Hyperdrive-client negative E2E.
  No production Worker redeployment is needed for this CI-only change.

**Only remaining TLS decision:** keep #344 **Open** with its Hyperdrive-client
negative E2E explicitly blocked until an allowed disposable configuration and
separate credential/cleanup proof path exists, or the Owner explicitly
accepts that residual evidence gap as a documented waiver. Neither an OpenSSL
origin test, a strict configured TLS mode nor a CI unit test silently
substitutes for this acceptance gate. Do not create a new Worker, deploy
system or Acceptance environment just to satisfy it.

## Aiven MySQL test replacement — historical live read-only E2E (2026-10-30)

The separate isolated MySQL Hyperdrive config and its initial protected
activation were successfully tested in [PR #518](https://github.com/lirtual/mcp-workers/pull/518),
[release #40995674654](https://github.com/lirtual/mcp-workers/actions/runs/40995674654)
and [activation #40996046557](https://github.com/lirtual/mcp-workers/actions/runs/40996046557).
These are historical PASS records. The MySQL test logical reference is
**currently disabled**, as independently read back above; do not infer
its current Active state from the earlier activation receipt.

## Original deleted-MySQL incident snapshot (2026-10-30; historical)

- Before the separate MySQL test config was created, independent Cloudflare account inventory contained only PostgreSQL Hyperdrive `eb4ccbd231ea44beabc72b3f2b483d69`; TLS is `verify-full` and caching is disabled. The former MySQL OpenList Hyperdrive `135ef2e15db049c68e99b0849f9a3da0` was deleted. Both the GitHub release readback and independent Cloudflare GET return HTTP 404 for this first manifest entry. This is a missing resource, **not evidence of a missing Hyperdrive Token permission**.
- Remove only the deleted OpenList source/manifest Binding; preserve the Aiven PostgreSQL E2E configuration, its CA, and both working MySQL Direct connections (`b2b`, `scrape_relay`). The OpenList D1 row was nonfunctional while Active; Owner subsequently disabled it via /setup (revision 3). It remains disabled pending separately authorized retirement.
- Existing protected `release.yml` must pass strict remaining-config readback and deploy/readback before any PostgreSQL D1 reference activation. Real PostgreSQL E2E and negative TLS validation remain NOT PERFORMED.

## Historical records (not current inventory)

## Current authoritative state (2026-10-29, three-mode scope approved)

**Current Owner scope:** exactly three combinations — MySQL Direct, MySQL Hyperdrive,
PostgreSQL Hyperdrive. PostgreSQL Direct is no longer a delivery requirement or
enabled Owner/MCP mode. PostgreSQL SQL/RLS/transactions/DDL are validated through
Hyperdrive; real deployed PostgreSQL Hyperdrive E2E and `verify-full` CA/hostname
negative tests remain required *before* claiming that mode accepted. Preserve
past Q1–Q46/four-mode notes below as historical decisions, not current release
requirements. Do not add a compatibility flag or a new test environment.

- Live Database MCP registry lists exactly three active connections: `b2b` and `scrape_relay` (MySQL Direct), plus `aiven_mysql_openlist` (MySQL Hyperdrive). All three passed fresh health checks and the OpenList Hyperdrive passed bounded `SELECT 1`. The previously used `aiven_mysql_test` and `aiven_pg_test` IDs, databases and dedicated Hyperdrive configurations have been retired; **do not recreate them**.
- The Owner management page's real verification-only GitHub Actions dispatch [#40850173389](https://github.com/lirtual/mcp-workers/actions/runs/40850173389) was accepted; all five jobs were skipped as intended. No database or Worker change was requested. The existing protected release now checks actual GitHub dispatch authorization before publication.
- Production Worker version `b1130c66-a961-4034-b4ca-f73da8e73d1b` was verified at 100% traffic. The managed D1 is the sole authoritative registry; the old flat configuration and original D1 were retired.
- Acceptance **not performed** on current origins: OpenList production Safe Write/DDL/escaping/rollback, deployed Hyperdrive TLS failure negatives, actual managed D1 backup/encryption-key restoration, and PostgreSQL Hyperdrive deployed E2E (no authorized isolated PostgreSQL origin currently exists). Historical test-origin successes do not substitute for these checks.
- Keep the three working connections unchanged. Do not run writes on business data, restore old test databases, or add a separate CI or deployment architecture simply to close Spec #344. The Owner has revised the four-mode requirement to three modes; the Issue stays open for remaining accepted-mode real E2E/security evidence.

## Previous test-origin state (historical; not current production inventory)

- The production `database-mcp-worker` uses exactly one Owner-managed D1
  registry: `database-mcp-registry` (`cbfe6a05-4979-4e6a-9cc2-4f6468586e4a`).
  Its `DB` binding and current encryption keys are required to read Direct rows.
- The Owner reconfigured `b2b` and `scrape_relay` as active MySQL Direct entries.
  Both passed production health and bounded `SELECT 1` (4/4). A separate
  isolated production test table passed Safe Write, structured DDL, over-limit
  DML rollback and verified cleanup. See [#344 evidence](https://github.com/lirtual/mcp-workers/issues/344#issuecomment-6486546568).
- MySQL Hyperdrive `aiven_mysql_test` is now **active**: actual production
  health, bounded SELECT, dedicated Aiven test-table Safe Write, DDL,
  21-row over-limit rollback and cleanup all passed
  ([E2E evidence](https://github.com/lirtual/mcp-workers/issues/344#issuecomment-6488549684)).
  PostgreSQL Hyperdrive `aiven_pg_test` remains **disabled** (revision 1).
  Its config/binding/CA/`verify-full` passed readback but activation was
  blocked by a platform safety check; its live E2E is **Not performed**.
  PostgreSQL Direct code is present but requires a separate approved plaintext
  test origin before real acceptance.
- The obsolete `DATABASE_CONFIG` Worker and GitHub Environment Secrets and
  old `database-mcp-db` D1 have been **deleted and verified** after the managed
  D1 cutover ([evidence](https://github.com/lirtual/mcp-workers/issues/344#issuecomment-6487209015)).
  Old Worker recovery and historical import are permanently retired.
- Never drop or rewrite migrations `0001_connections.sql` or
  `0002_transport_and_retired_ids.sql`: they are already applied to the live D1.
  Deleting/replacing a D1 record or restoring a historical whole-D1 snapshot
  can affect the retired-ID ledger. Freeze Owner changes and reconcile IDs
  against independent evidence before restoring an older snapshot.

## Routine release and recovery

1. Use only the existing GitHub Actions **Release Worker** workflow on reviewed
   current `main`, selecting `database-mcp-worker`, explicitly approving
   `deploy_to_production`, and setting `database_expected_release_sha` to that exact
   reviewed SHA. A later main advance blocks publication. Do not introduce another deployment system.
2. The normal release enforces application/database integration CI, approved
   exact source and Owner Access, the required Secrets and D1 binding, a
   read-only registry/migrations/retired-ID check, authenticated decryptability
   of each Direct row using its key ID, and exact active-version/binding readback.
   It must not import historical catalog data or mutate production D1.
3. If a code release fails **before publication**, leave the current Worker
   running and fix the cause. If a published version regresses, revert the
   offending source change through the existing GitHub review/merge route and
   release that compatible `main` using the same protected workflow. Before
   using a prior code revision, check that it understands the **current D1
   schema and encryption-key generation**. Never redeploy the old flat-catalog
   Worker version as a recovery shortcut.
4. If the registry or encryption key is lost, a code-only rollback cannot
   restore connections. The Owner must restore a validated D1 snapshot with
   its matching current/historical encryption keys, or reconfigure connection
   records through `/setup`. No historical backup/key compatibility is
   claimed merely because a Secret name exists. Keep historical keys while
   any retained snapshot needs them; Owner key-rotation attestation is not
   proof of successful recovery.
5. After an approved production release, independently verify that all expected
   **active** logical connections still appear and pass bounded health/constant SELECT
   without accessing business tables. Report E2E separately from successful CI
   or Cloudflare publication.

## Legacy resource retirement — completed

After [PR #448](https://github.com/lirtual/mcp-workers/pull/448)
merged and the managed-D1 Worker passed real E2E, the obsolete
`DATABASE_CONFIG` Cloudflare/GitHub Secrets and old `database-mcp-db` D1
were individually deleted and independently verified; live connections
remained healthy. Do not recreate them for compatibility with the retired
flat-catalog Worker. The current D1 encryption keys remain required.
Historical managed-D1 snapshot recovery was **not performed**, not PASS.

For Hyperdrive logical-ID retirement, disable first; remove the reviewed Binding
and source manifest, publish the normal production release and independently
confirm unbinding and rollback-eligible version restrictions. Dispatch the same
Release Worker with `database_hyperdrive_retire_approved=true`,
`database_hyperdrive_id` and `database_hyperdrive_revision` for the exact disabled ID only after that release. The protected action verifies current active
production bindings, D1 identity/revision and sharing, CAS-deletes the disabled
row and confirms the retired-ID ledger. It does **not** delete the upstream
Hyperdrive config or CA; independently establish other-service/old-version/CA
non-use before any separately authorized Cloudflare deletion.

Current three-mode Spec #344 stays open for PostgreSQL Hyperdrive activation/E2E,
deployed Hyperdrive TLS negatives, and outstanding current-origin safety evidence.
PostgreSQL Direct is not an acceptance gate. No production migration or
resource recreation is needed solely to eliminate it from the supported modes.

## Historical four-mode staged enablement (old test origins now retired)

This section records prior Aiven test-origin evidence only; those test services were subsequently deleted and must not be re-provisioned for this runbook.
The original plan was to provision two named test Hyperdrive configurations through the existing
protected Release Worker workflow and existing GitHub Secrets; do not log passwords.
The Owner page may save an unverified Hyperdrive reference only as **disabled**. This is historical behavior; the new Spec #476 path blocks manual Hyperdrive `/setup/add` and permits only the verified post-release disabled-reference handoff.
A protected activation must verify the dedicated Cloudflare binding, exact origin,
strict CA/hostname mode, disabled caching and real deployed Worker health **while
D1 remains disabled**, through the private signed `/internal/hyperdrive-health`
preflight. The existing release encryption Secret is HKDF-separated into a
short-lived proof key in Owner Actions and the Worker; bearer token alone cannot
probe disabled connections. The protected action rechecks D1 revision and Cloudflare
binding, then CAS-enables only after the successful read-only Worker probe.
Failed probes never expose an unverified active connection. A successful synthetic test, local CI or Cloudflare config GET is not a
substitute for real TLS-negative, Safe Write, DDL and rollback acceptance.
PostgreSQL Direct remains intentionally **plaintext** and requires a separately
authorized reachable plaintext origin; the TLS-only Aiven PostgreSQL service is
not a substitute. Never use the live business connections for these probes.

## 2026-10-29 — origin-side TLS negative evidence

On the existing Aiven **MySQL and PostgreSQL** test hosts, real OpenSSL
STARTTLS handshakes (no SQL or credentials) verified that each correct
project CA/hostname combination succeeded, while wrong-CA and wrong-hostname
cases failed certificate verification. These are **origin-side negative tests**,
not the pending Cloudflare Workers→Hyperdrive full negative matrix. No
production configuration was modified for these tests.


## Spec #476 local implementation boundary (not production acceptance)

See the [Database README](../apps/database-mcp-worker/README.md#spec-476-implementation-boundary)
for the current capability and blocking conditions. The single additive operation ledger migration
`0003_hyperdrive_operations.sql` (including apply run receipts) has not been applied by this phase. The existing release performs read-only
schema validation and will block until a separately authorized migration applies it;
it does not auto-migrate this production registry. Existing Worker connections and CA
were not modified or freshly tested here.

Preparation stops at a verified allowlisted PR (draft under protected policies). Owner final apply now claims a D1 operation
before dispatch and verifies exact source/main and GitHub merge eligibility before a
job-token merge. Protected main requires real PR checks/reviews. Only explicit classic
protection 404 plus independently empty rulesets permits Owner dispatch of existing
`ci.yml` on the deterministic `db476-<UUID>` branch with exact candidate SHA. Its
Application checks, Database integration and Required checks gate must all succeed;
actor, workflow, branch, SHA and real Run/job receipts are checked. No production
secrets enter that CI. Read-only polling is bounded; 204/no Run ID, unknown dispatch,
queued timeout or failed/skipped/ambiguous jobs never merge or request deployment.
The recorded CI Run remains inspectable; no automatic redispatch follows ambiguity. It proves the actual merged SHA from GitHub before requesting the
existing protected production release with that exact pin. Unknown outcomes cannot
be retried automatically. `apply_policy_unavailable` includes unreadable protection;
no credential or repository setting changes are authorized to bypass this gate.

A verified release Run ID is only `running/apply_release_pending`, not publication or
activation. The dependent protected reconciliation job in `release.yml` consumes
`needs.deploy.outputs.version_id` only after deploy success. It verifies the exact
Run/SHA, 100% version, current and version-specific bindings and strict Cloudflare
configuration, then hands off the reservation to a disabled revision-1 D1 reference.
The operation's `completed/postrelease_disabled` status confirms only this handoff.
Activation still requires the existing protected `/setup` health gate. Lost D1 write
acknowledgements are reconciled by exact readback; ambiguous evidence stops without
retry, deployment rollback or automatic SQL enablement. 0003 includes the constrained
handoff trigger and immutable nonsecret target metadata; it remains unapplied here.
The reported disabled
Actions PR setting still blocks before any Cloudflare call, even when main is
explicitly unprotected. Enabling it is a separate Owner setting action, not performed
by these scripts. A 403 or unknown protection policy still blocks; an empty ruleset
list alone is insufficient. Do not dispatch a lifecycle release based on draft PR creation or the
historical no-deploy dispatch smoke. Do not add credentials or weaken protections to
work around these blocks.

For an unknown operation, inspect exact Run/PR/config receipts read-only. The
`resource_write_started_at` marker prohibits automatic retry of a possibly accepted
Cloudflare POST. Expired ciphertext is erased but unknown identity reservations stay
locked; no manual row deletion/recreation is authorized by this runbook. The old Aiven
test provisioning script is retired and must not return; deleted test databases stay
deleted. Retirement retains Cloudflare resources and shared CA, and now refuses D1
retirement while any enumerated rollback version still references its config or binding.
