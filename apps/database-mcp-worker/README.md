# Database MCP Worker · Spec #344

Cloudflare MCP Worker for bounded SQL reads, schema inspection, structured Safe Write and controlled DDL. [Spec #344](https://github.com/lirtual/mcp-workers/issues/344) defines the incremental D1 registry and future dual-transport design.

## Delivery boundary

**Production status (2026-10-29):** MySQL Direct (`b2b`, `scrape_relay`)
and MySQL Hyperdrive (`aiven_mysql_test`) are **active**. The latter passed
live health, bounded SELECT, isolated Safe Write, DDL, rollback and verified
cleanup ([evidence](https://github.com/lirtual/mcp-workers/issues/344#issuecomment-6488549684)).
The protected [Release Worker #40818135359](https://github.com/lirtual/mcp-workers/actions/runs/40818135359)
published both Aiven bindings. PostgreSQL Hyperdrive `aiven_pg_test` is
**disabled**: Cloudflare config, CA, strict `verify-full` and binding are
verified but its activation was blocked by a platform safety check; live E2E
is **Not performed**. PostgreSQL Direct is implemented but no separate
plaintext test source was accepted. Spec #344 remains **Open**.

The current managed D1 `database-mcp-registry` is the only registry.
Legacy `DATABASE_CONFIG` Secrets and original D1 were removed and verified
([evidence](https://github.com/lirtual/mcp-workers/issues/344#issuecomment-6487209015));
the original flat-catalog Worker is no longer a supported recovery target.

The new D1 `database_connections` registry supports 0–10 configured logical connections; disabled rows count. IDs, database targets and dialect/transport are immutable (credential-only URL edits; new target requires a new ID), revisions are CAS-checked, and `retired_connection_ids` prevents ID reuse on normal delete. A historical whole-D1 restore can roll back that retirement history: freeze changes and reconcile against independently retained identity evidence before allowing adds/enables.

`migrations/0001_connections.sql` and `0002_transport_and_retired_ids.sql` remain the reviewed additive schema. They were applied to the **new initially empty** D1 only. Do not import historical ciphertext or activate preloaded old records.

## Transport contracts

| Transport | Origin data | Connection security | Changes |
|---|---|---|---|
| **Direct** | AES-256-GCM encrypted URL per D1 row | **Plaintext TCP**, explicitly insecure; credentials and SQL can be intercepted | Direct records may be changed individually with no Worker release |
| **Hyperdrive** | Nonsecret config ID and binding name in D1; origin password and CA only in Cloudflare | **Must be separately proven** strict chain/hostname TLS and disabled caching at the Hyperdrive → origin boundary | Dedicated Cloudflare config and versioned Worker binding through the existing protected GitHub Actions release |

The Owner `/setup` page uses Cloudflare Access exact-email OTP, native Access identity with strict signed-JWT fallback, Origin/CSRF checks and throttling. Direct creation and sensitive credential edits require plaintext-risk acceptance. A logical ID must keep the same host/IP, port and database; changing target requires a new ID. Passwords, URLs, CA, keys and ciphertext are never displayed. PostgreSQL Direct requires explicit plaintext acceptance; live E2E remains unverified. Hyperdrive references enter D1 **disabled** and require protected Owner/main GitHub Actions activation with Cloudflare readback and live health. MySQL Hyperdrive is now active; PostgreSQL Hyperdrive is still disabled.

**Important gate:** `hyperdrive-bindings.json` is the reviewed nonsecret binding/config-ID + origin/CA provenance mapping, containing the two reviewed Aiven test bindings. Each real entry must contain `binding`, `id`, `dialect`, `origin_host`, `origin_port`, `origin_database`, and `ca_certificate_id`. The origin password and PEM must NEVER appear in that file. The existing GitHub Actions release uses a read-only Cloudflare Hyperdrive GET (requires **Hyperdrive Read** on its existing token) both before and after deployment to compare the exact origin and CA, require PostgreSQL `verify-full` / MySQL `VERIFY_IDENTITY`, and require `caching.disabled=true`. The release preflight compares it against the reviewed Wrangler `hyperdrive` entries and readback checks the deployed IDs. Runtime rejects any missing or mismatched Binding. This alone **does not prove** source Hyperdrive configuration, CA trust, hostname validation, disabled query cache, pool restart, or rollback-version safety; these remain mandatory external verification gates before any Hyperdrive activation. No account-management token is embedded in the production Worker.

For MySQL Hyperdrive, the driver cannot use protocol-level prepared `execute()`. Structured writes use `query(sql, params)` only for primitive values and verify `NO_BACKSLASH_ESCAPES` is absent from the **same transaction/session immediately before interpolation**. This is **not a server-side parameter binding**, and deployed Workers escaping/injection/rollback tests remain P0 requirements. PostgreSQL Hyperdrive must respect transaction pooling. Never retry ambiguous non-idempotent commits.

The existing MCP tools remain: `list_connections`, `inspect_schema`, `get_schema_context`, `query_read`, `explain`, `health_check`, `insert_rows`, `update_rows`, `delete_rows`, `create_table`, `alter_table`, `create_index`, `drop_index`, `drop_table`. Existing row, result-byte, query-time and write-affected-row limits remain.

## Security and release checks

Direct public-host/DNS/address checks are retained, with documented DNS rebinding/TOCTOU residual risk. Never use Direct with a server requiring encrypted database traffic. Database GRANT/RLS and transactional engine properties remain the authorization and rollback boundaries.

The Worker requires `MCP_ACCESS_TOKEN`, `DATABASE_ENCRYPTION_KEY`, `DATABASE_KEY_ID`, a dedicated D1 `DB` binding, `RATE_LIMITER`, `SETUP_RATE_LIMITER`, and the existing Owner Access Variables. Bounded CAS key rotation applies **only to encrypted Direct records**; retained rollback versions and backups must be compatible with both current and historic encryption keys.

For subsequent releases use only existing protected GitHub Actions with read-only D1/Access/binding gates and exact active-version checks; the old importer and legacy rollback dispatch are retired. For a sensitive Hyperdrive Cloudflare change: disable the logical connection, change the dedicated upstream config with approved access, restart/drain its native pool, verify **new connections** and TLS/caching/binding provenance, then explicitly enable. Failures remain disabled. Before deleting a Hyperdrive record, safely unbind and verify live/rollback versions and shared-CA dependencies. Do not add auto-cleanup or another orchestrator.

```bash
pnpm --filter database-mcp-worker check
node --test scripts/manual-worker-release.test.mjs
```

Unit tests and dry-run are not deployed Workers acceptance. MySQL Direct and MySQL Hyperdrive have separate production E2E evidence. PostgreSQL Hyperdrive remains disabled pending protected activation and live E2E; PostgreSQL Direct lacks an accepted plaintext origin. Both Aiven hosts passed origin-side CA and hostname negatives, which do not replace deployed Workers TLS-negative acceptance. Real production writes and DDL were exercised only against a dedicated test table and cleaned up; no authorization to modify existing business tables follows. See [production cutover and rollback](../../docs/database-cutover-344.md), [historical Direct TLS investigation](docs/direct-tls-feasibility.md), and [Spec #344](https://github.com/lirtual/mcp-workers/issues/344).

## License

MIT; upstream provenance retained in `LICENSE` and `SOURCE.md`.
