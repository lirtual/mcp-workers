# Database MCP Spec 344 — production cutover and rollback checklist

**Status: BLOCKED. This document grants no deployment or migration approval.**
Do not test the existing scrape_relay and b2b business connections. Use only
owner-provisioned disposable Aiven MySQL/PostgreSQL for feature acceptance.

## Required independent evidence before production cutover

1. Real Cloudflare Workers Direct TLS verified for both MySQL and PostgreSQL:
   hostname and certificate trust, read/write/health/DDL, and certificate,
   hostname and plaintext negative tests. CI Node tests cannot substitute.
2. Independent Owner self-hosted Cloudflare Access application on the exact
   configured custom domain, one exact owner-email allow policy, OTP, short
   session, and real browser JWT/Origin/CSRF negative tests.
3. Dedicated approved D1, schema migration, AES-GCM keys and backup/key
   compatibility. Preserve sufficient historical keys for D1 Time Travel
   and any retained manually exported encrypted snapshots.
4. Explicitly freeze the authoritative old catalog and independently compare
   every old ID, dialect and confidential URL with the encrypted D1 record.
   Never echo any credentials, ciphertext or CA material in logs or artifacts.
   The offline-only source helper in src/registry/import.ts prepares and inserts
   a single SQLite statement; it imports disabled and DOES NOT run in any
   deployed route or CI migration workflow. Repeated imports/collisions fail.
   The offline verifyLegacyCatalogReadback helper independently opens every
   stored D1 ciphertext using authenticated AES-GCM and checks the original
   ID, dialect, URL and absence of unapproved custom CA. A row count or status
   is NOT equivalent to this cryptographic source-to-D1 verification.
5. Existing migrated IDs cannot become active until individually verified with
   real TLS and health evidence. The owner disallows testing the two current
   business databases; their individual validation must stay BLOCKED and
   consequently production cutover stays BLOCKED, regardless of Aiven tests.
6. At a separately approved release: recheck the exact main SHA, source and
   runtime D1 bindings, expected legacy IDs and ACTIVE status, Access policy,
   immutable version, rollback candidate and successful real Portal + Owner
   smoke. Do not delete or restage the old catalog secret automatically.

## Failure and recovery

- Until activation and cutover, keep the existing Worker and original Secret.
  Reject all release attempts if D1/Access/expected IDs are missing or disabled.
- On a failed cutover, use ONLY a previously verified D1-compatible code
  version; preserve D1 state and encryption keys. Do not silently deploy
  old JSON-based Worker code over newly modified D1 data.
- Any return to the old JSON source requires separate owner authorization,
  freeze and backup of current D1, reconciliation of all post-cutover changes,
  and proof that old/new encryption keys and catalog snapshots are recoverable.
- D1 Time Travel restores a whole database, not one connection row.
- No credential export, secret deletion, Aiven subscription changes or
  Cloudflare production mutation is authorized by this checklist.
