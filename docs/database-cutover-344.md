# Database MCP #344 — production release and recovery (managed D1 only)

## Current authoritative state (2026-10-29)

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
   current `main`, selecting `database-mcp-worker` and explicitly approving
   `deploy_to_production`. Do not introduce another deployment system.
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
Release Worker with `database_hyperdrive_retire_approved` and the exact disabled
ID/revision only after that release. The protected action verifies current active
production bindings, D1 identity/revision and sharing, CAS-deletes the disabled
row and confirms the retired-ID ledger. It does **not** delete the upstream
Hyperdrive config or CA; independently establish other-service/old-version/CA
non-use before any separately authorized Cloudflare deletion.

Full four-mode Spec #344 stays open for PostgreSQL Hyperdrive activation/E2E,
PostgreSQL Direct plaintext E2E and deployed Hyperdrive TLS negatives.

## 2026-10-29 — four-mode staged enablement

Existing Aiven test services are used for MySQL and PostgreSQL Hyperdrive evidence.
Provision only the two named test Hyperdrive configurations through the existing
protected Release Worker workflow and existing GitHub Secrets; do not log passwords.
The Owner page may save an unverified Hyperdrive reference only as **disabled**.
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
