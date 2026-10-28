# Spec #344 — one-time D1 preparation without production Worker release

This narrowly scoped preparation adds only reviewed Database D1 migration files, a one-shot encrypted importer and a protected job **inside the existing manual Release Worker workflow**. It does not change the production Database Worker source or Wrangler manifest, add a new Worker/environment/CI workflow, or replace the current `DATABASE_CONFIG` runtime Secret.

## Preconditions (operator must verify independently)

- Keep the existing production `database-mcp-worker` and its original Cloudflare `DATABASE_CONFIG` Secret intact and serving traffic. Historical live read-only health and `SELECT 1` passed for `scrape_relay` and `b2b`, but this is **not** a validation of the new D1 runtime.
- In the existing protected GitHub **database-mcp-worker Environment**, reuse a Secret named **`DATABASE_CONFIG`** with the exact authorized *original* JSON map for those two MySQL Direct IDs only. If the Secret exists only in Cloudflare, **its value cannot be read back via Cloudflare API**: use a separately authenticated original source. Never put credentials, complete URLs, keys or JSON in chats, issues, logs, workflow inputs or Git.
- The Environment must also have **`DATABASE_ENCRYPTION_KEY`** (canonical Base64 encoding of a recoverable 32-byte key), **`DATABASE_KEY_ID`** (stable identifier), and the existing Cloudflare API token. Set `DATABASE_CUTOVER_EXPECTED_IDS` as a GitHub Environment Variable to the exact approved two-ID JSON list; use the existing `CLOUDFLARE_ACCOUNT_ID` Variable. Do not rotate/create keys without an approved recovery source.
- Independently attest both imported MySQL targets/principals and equality with the **deployed** original config, since reading the original Cloudflare Secret back is not supported. Verify Cloudflare account and existing dedicated D1 `database-mcp-db`, and that migration `0001_connections.sql` is present, `0002_transport_and_retired_ids.sql` absent and the registry empty.
- Have explicit authorization for **the D1-only schema mutation and import**. This PR is **not itself authorization** to apply migrations, alter business databases, deploy code, activate a connection, convert TLS/plaintext transports, change Secrets, or merge the full Draft PR #345.

## Exactly scoped manual path, after reviewed code reaches main

Run the existing `Release Worker` workflow on **`main`**, with `worker=database-mcp-worker`, `deploy_to_production=false`, and `database_prepare_approved=true`. All other dispatches leave the preparation job inactive. Owner actor, main source SHA, existing protected Environment and release concurrency group are checked.

1. Perform **only read-side** validation of the exact two input IDs, MySQL Direct URL shape, approved key ID and AES-GCM round-trip, D1 ID, schema ledger and record counts. Missing/mismatched data fails before production D1 mutation.
2. Generate a **temporary** migration-only Wrangler config, in the database app working directory, using the existing dedicated D1 ID. Apply only checked-in `0001`/`0002` through normal `wrangler d1 migrations apply ... --remote --config .db344-prep.generated.json`. The generated file is removed even on failure. It is **not** the production Worker configuration.
3. Encrypt two records with per-ID/dialect AES-256-GCM AAD and insert them in one atomic D1 statement, status=`disabled`. Independently read back only ID, dialect, transport, status, key identifier, revision and ciphertext length. No plaintext export, no upstream database SQL, no Worker publish or automatic enable.
4. If a migration succeeds but import fails, do **not** repeatedly run the job, forge D1 ledger entries or publish the Worker. Stop and reconcile the partial D1 state under separately approved recovery. The legacy Worker continues to serve traffic.

## Not a cutover

An import success means only *two disabled encrypted D1 records* are prepared. The new Worker from PR #345 is still Draft, has unverified release/cutover requirements, and would not serve these disabled connections automatically. A later separately approved cutover needs explicit no-outage activation and rollback controls, followed by the Owner-selected minimal **production read-only acceptance**. This preparation leaves all existing business credentials, production traffic, and old Secret untouched.
