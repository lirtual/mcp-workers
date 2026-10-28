# Database MCP Worker · Spec #344

Cloudflare MCP Worker for bounded MySQL/PostgreSQL reads, schema inspection, structured Safe Write and controlled DDL. The [approved Spec #344](https://github.com/lirtual/mcp-workers/issues/344) supersedes the old Direct-TLS-only Draft. **This worktree is unmerged implementation in progress, not a production cutover approval.**

## Delivery boundary

**Production migration and release: BLOCKED.** The currently deployed Worker still uses its pre-cutover `DATABASE_CONFIG` Secret. Do not overwrite/delete that Secret, modify production D1, probe business databases, or publish this code without separate explicit authorization and the full acceptance matrix. The earlier Aiven Hyperdrive `SELECT 1` evidence is only partial.

The new D1 `database_connections` registry supports 0–10 configured logical connections; disabled rows count. IDs and dialect/transport are immutable, revisions are CAS-checked, and `retired_connection_ids` prevents ID reuse on normal delete. A historical whole-D1 restore can roll back that retirement history: freeze changes and reconcile against independently retained identity evidence before allowing adds/enables.

`migrations/0001_connections.sql` is unchanged. **Additive `0002_transport_and_retired_ids.sql` has not been applied to production.** It preserves existing encrypted Direct ciphertext while **disabling all migrated connections and incrementing revisions** to prohibit automatic old TLS → new plaintext downgrade; explicit risk confirmation is required before later enabling. Hyperdrive references are added without storing origin credentials.

## Transport contracts

| Transport | Origin data | Connection security | Changes |
|---|---|---|---|
| **Direct** | AES-256-GCM encrypted URL per D1 row | **Plaintext TCP**, explicitly insecure; credentials and SQL can be intercepted | Direct records may be changed individually with no Worker release |
| **Hyperdrive** | Nonsecret config ID and binding name in D1; origin password and CA only in Cloudflare | **Must be separately proven** strict chain/hostname TLS and disabled caching at the Hyperdrive → origin boundary | Dedicated Cloudflare config and versioned Worker binding through the existing protected GitHub Actions release |

The Owner `/setup` page is isolated behind Cloudflare Access exact-email OTP, signed JWT, Origin and CSRF checks, and throttling. Direct creation and sensitive URL edits require an explicit plaintext-risk checkbox. Hyperdrive additions remain disabled until binding release and verification; no transport downgrade occurs. The Owner UI cannot enable Hyperdrive; a separate Owner-approved operation in the **existing Release Worker workflow** reads back actual Cloudflare TLS/CA/origin/cache and deployed Binding, then CAS-enables the D1 row and immediately verifies live MCP health. Failure triggers CAS-disable; this cannot make cross-service changes atomic, so external Cloudflare updates must always follow disable/restart/recheck change control. Neither passwords, URLs, CA, keys nor ciphertext are displayed.

**Important gate:** `hyperdrive-bindings.json` is the reviewed nonsecret binding/config-ID + origin/CA provenance mapping, currently `[]`. Each real entry must contain `binding`, `id`, `dialect`, `origin_host`, `origin_port`, `origin_database`, and `ca_certificate_id`. The origin password and PEM must NEVER appear in that file. The existing GitHub Actions release uses a read-only Cloudflare Hyperdrive GET (requires **Hyperdrive Read** on its existing token) both before and after deployment to compare the exact origin and CA, require PostgreSQL `verify-full` / MySQL `VERIFY_IDENTITY`, and require `caching.disabled=true`. The release preflight compares it against the reviewed Wrangler `hyperdrive` entries and readback checks the deployed IDs. Runtime rejects any missing or mismatched Binding. This alone **does not prove** source Hyperdrive configuration, CA trust, hostname validation, disabled query cache, pool restart, or rollback-version safety; these remain mandatory external verification gates before any Hyperdrive activation. No account-management token is embedded in the production Worker.

For MySQL Hyperdrive, the driver cannot use protocol-level prepared `execute()`. Structured writes use `query(sql, params)` only for primitive values and verify `NO_BACKSLASH_ESCAPES` is absent from the **same transaction/session immediately before interpolation**. This is **not a server-side parameter binding**, and deployed Workers escaping/injection/rollback tests remain P0 requirements. PostgreSQL Hyperdrive must respect transaction pooling. Never retry ambiguous non-idempotent commits.

The existing MCP tools remain: `list_connections`, `inspect_schema`, `get_schema_context`, `query_read`, `explain`, `health_check`, `insert_rows`, `update_rows`, `delete_rows`, `create_table`, `alter_table`, `create_index`, `drop_index`, `drop_table`. Existing row, result-byte, query-time and write-affected-row limits remain.

## Security and release checks

Direct public-host/DNS/address checks are retained, with documented DNS rebinding/TOCTOU residual risk. Never use Direct with a server requiring encrypted database traffic. Database GRANT/RLS and transactional engine properties remain the authorization and rollback boundaries.

The Worker requires `MCP_ACCESS_TOKEN`, `DATABASE_ENCRYPTION_KEY`, `DATABASE_KEY_ID`, a dedicated D1 `DB` binding, `RATE_LIMITER`, `SETUP_RATE_LIMITER`, and the existing Owner Access Variables. Bounded CAS key rotation applies **only to encrypted Direct records**; retained rollback versions and backups must be compatible with both current and historic encryption keys.

Use the existing GitHub Actions workflow only after authorized migration and the read-only D1/Access/binding checks pass. For a sensitive Hyperdrive Cloudflare change: disable the logical connection, change the dedicated upstream config with approved access, restart/drain its native pool, verify **new connections** and TLS/caching/binding provenance, then explicitly enable. Failures remain disabled. Before deleting a Hyperdrive record, safely unbind and verify live/rollback versions and shared-CA dependencies. Do not add auto-cleanup or another orchestrator.

```bash
pnpm --filter database-mcp-worker check
node --test scripts/manual-worker-release.test.mjs
```

Unit tests and dry-run are not deployed Workers acceptance. All **four** dialect/transport combinations must pass connection, read/schema/explain, Safe Write and rollback, controlled DDL, negatives, TLS and security gates before #344 is production-ready. Existing `scrape_relay` and `b2b` database access is specifically prohibited without fresh separate Owner authorization. See [production cutover and rollback](../../docs/database-cutover-344.md), [historical Direct TLS investigation](docs/direct-tls-feasibility.md), and [Spec #344](https://github.com/lirtual/mcp-workers/issues/344).

## License

MIT; upstream provenance retained in `LICENSE` and `SOURCE.md`.
