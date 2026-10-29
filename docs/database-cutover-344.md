# Database MCP #344 — production release and recovery (managed D1 only)

## Current authoritative state (2026-10-29)

- The production `database-mcp-worker` uses exactly one Owner-managed D1
  registry: `database-mcp-registry` (`cbfe6a05-4979-4e6a-9cc2-4f6468586e4a`).
  Its `DB` binding and current encryption keys are required to read Direct rows.
- The Owner reconfigured `b2b` and `scrape_relay` as active MySQL Direct entries.
  Both passed production health and bounded `SELECT 1` (4/4). A separate
  isolated production test table passed Safe Write, structured DDL, over-limit
  DML rollback and verified cleanup. See [#344 evidence](https://github.com/lirtual/mcp-workers/issues/344#issuecomment-6486546568).
- Only MySQL Direct is active. PostgreSQL Direct and either Hyperdrive dialect
  remain disabled until separate runtime and strict TLS/CA/hostname acceptance.
- The old flat `DATABASE_CONFIG` catalog is **not** an input to the production
  Worker. Its original D1 `database-mcp-db` and legacy Secret may still exist
  in Cloudflare during retirement, but neither is a recovery dependency.
  The previous legacy Worker restoration and one-time import/prepare actions
  are retired from the Release Worker workflow.
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
5. After an approved production release, independently verify that both
   logical connections still appear and pass bounded health/constant SELECT
   without accessing business tables. Report E2E separately from successful CI
   or Cloudflare publication.

## Legacy resource retirement — separate production step

Source and release-workflow cleanup **does not delete** Cloudflare Secrets,
old D1, historical Worker versions or GitHub Environment settings. Once the
simplified `main` release and real two-connection read-only E2E pass:

- Verify no active consumer or retained recovery snapshot still requires the
  old `DATABASE_CONFIG` Secret or old `database-mcp-db` D1. In particular,
  confirm none of the supported rollback-compatible releases depends on them.
- Remove the obsolete Cloudflare Secret, old D1 and related GitHub Environment
  Secret only as explicitly authorized, individually controlled resource
  operations. Keep current `DATABASE_ENCRYPTION_KEY`, `DATABASE_KEY_ID`, new
  D1 and all actively needed historical encryption keys.
- Recheck current live D1 bindings, connection listing, health and bounded
  reads after cleanup. Do not treat resource deletion or live restore as
  performed until the actual steps and E2E evidence are recorded.

Full four-mode Spec #344 remains open for deferred security/transport scope;
retiring legacy compatibility does **not** constitute an approval to enable
PostgreSQL Direct or Hyperdrive.

## 2026-10-29 — four-mode staged enablement

Existing Aiven test services are used for MySQL and PostgreSQL Hyperdrive evidence.
Provision only the two named test Hyperdrive configurations through the existing
protected Release Worker workflow and existing GitHub Secrets; do not log passwords.
The Owner page may save an unverified Hyperdrive reference only as **disabled**.
A protected activation must verify the dedicated Cloudflare binding, exact origin,
strict CA/hostname mode, disabled caching and real deployed Worker health before
enabling. A successful synthetic test, local CI or Cloudflare config GET is not a
substitute for real TLS-negative, Safe Write, DDL and rollback acceptance.
PostgreSQL Direct remains intentionally **plaintext** and requires a separately
authorized reachable plaintext origin; the TLS-only Aiven PostgreSQL service is
not a substitute. Never use the live business connections for these probes.
