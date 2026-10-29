# Database MCP #344 — Production release and recovery

## Verified baseline (2026-10-29)

The Owner chose **no migration of legacy connection data**. New D1
`database-mcp-registry` (`cbfe6a05-4979-4e6a-9cc2-4f6468586e4a`) received
the reviewed schema and became the live Worker `DB` binding. Old D1
`database-mcp-db` (`8853a6ac-beaa-45aa-bdb2-0867e6f3df6d`) was not imported
or modified during cutover.

The normal [Release Worker #40798303006](https://github.com/lirtual/mcp-workers/actions/runs/40798303006)
succeeded at source `8f73efffa795`; the release readback identified version
`592b4d10-1904-4ad1-b8e2-9e5b554ea87d`, 100% active, bound to the new D1.
The Owner then added `b2b` and `scrape_relay` via the OTP-protected
[setup page](https://database.lirtual.dpdns.org/setup). Both MySQL Direct
connections passed production health and bounded `SELECT 1` (4/4);
see [acceptance evidence](https://github.com/lirtual/mcp-workers/issues/344#issuecomment-6485167119).
This is a historical release readback, not a continuous live-status guarantee.

The temporary empty-catalog period is over for these two connections.
The old `DATABASE_CONFIG` Secret and original Worker recovery version remain
retained but **are not active**. The legacy restore procedure was **not exercised**.

## Current operating contract

- **Only MySQL Direct is enabled.** It uses plaintext TCP with explicit
  acceptance. PostgreSQL Direct and both Hyperdrive modes fail closed pending
  separately approved implementation and strict TLS/security evidence.
- D1 holds 0–10 logical connections. The ID, dialect, transport and database
  target (host/IP, port, database name) are immutable. Owner setup permits
  credential updates for the same target, not target substitution. To move to
  another target, disable/delete the old connection and use a different ID.
  Deleted IDs are retired and cannot be reused within this registry.
- The Owner may add, test, change credentials, enable, disable, delete and
  re-encrypt Direct connections at `/setup`. Never put database URLs or
  credentials in Issues, logs or CI. Direct encryption-key rotation does **not**
  rotate upstream MySQL passwords. The Owner setup rotation form now requires
  an explicit recovery-compatibility attestation. This is **not automatic proof**:
  independently check all rollback-eligible Worker versions and retained D1
  backup key generations before confirming. Retain previous keys until rollback and
  backups have been accounted for.
- Production Safe Write, DDL, transaction rollback, negative-security matrix
  and legacy recovery drill are **Not performed**. The bounded 4/4 read-only
  smoke does not authorize broader business-data access.
- Historical whole-D1 restore can roll back the retired-ID ledger. Freeze
  creation/activation and reconcile against independent historical identity
  evidence before permitting new configuration operations.

## Subsequent releases and recovery

1. Use the **existing manual Release Worker** GitHub Actions workflow from
   the reviewed `main` SHA. Recheck D1 schema and binding, Owner Access
   policy, supported modes, required secrets and latest approved version.
   Do **not** rerun the historical first-time migration/import.
2. A normal code release must retain all Owner-managed D1 records, must not
   restage legacy `DATABASE_CONFIG` as the active catalog, and must confirm
   the exact active version/bindings after publish.
3. On release failure, use only the separately authorized, pinned legacy
   Worker recovery procedure after checking Secret, version and compatibility.
   This fallback still points to the old catalog, not automatically to any
   new D1 connection; do not assume rollback restores Owner-managed edits.
   Recovery was **not exercised** in the 2026-10-29 acceptance.
4. Never retire legacy Worker resources, the old D1, encryption keys or
   `DATABASE_CONFIG` without separate reviewed recovery/retirement evidence.
   Never enable deferred modes without their actual Workers tests and security
   acceptance.

Old Draft, zero-row and `database_prepare_approved` cutover instructions are
**historical only**, not actions to repeat. For the original design and
outstanding four-mode scope see [Spec #344](https://github.com/lirtual/mcp-workers/issues/344).
