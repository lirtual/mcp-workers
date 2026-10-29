# Database MCP Worker · Spec #344

Cloudflare MCP Worker for bounded SQL reads, schema inspection, structured Safe Write and controlled DDL. [Spec #344](https://github.com/lirtual/mcp-workers/issues/344) defines the incremental D1 registry and future dual-transport design.

## Delivery boundary

**Production state (2026-10-29):** MySQL Direct `b2b` and `scrape_relay` remain active and
unchanged. The dedicated MySQL Hyperdrive logical connection `aiven_mysql_openlist` is
**active**, using Cloudflare Hyperdrive `aiven-mysql-openlist` for the Aiven `openlist`
database as `avnadmin`; protected activation
([Action #40834639046](https://github.com/lirtual/mcp-workers/actions/runs/40834639046))
and live read-only health / `SELECT 1` passed. Real OpenList production write and DDL
acceptance was **not performed**.

Legacy D1 test IDs `aiven_mysql_test` and `aiven_pg_test` were CAS-disabled, unbound in
[PR #460](https://github.com/lirtual/mcp-workers/pull/460), independently retired through
protected Actions, confirmed in `retired_connection_ids`, and their dedicated Cloudflare
Hyperdrive configurations removed after verifying none of the 20 current Workers refer
to them. Historical test IDs must never be reused. The Aiven project CA remains valid
and in use by the active OpenList Hyperdrive; it retains its legacy human-readable
test-oriented name because Cloudflare rejects duplicate certificate uploads (1471),
deletion while in use (1476), and updates with invalid substitute CA (2015).
Do not delete the CA or downgrade `VERIFY_IDENTITY` merely to change its name.
Prior test-only Hyperdrive E2E evidence is retained
([evidence](https://github.com/lirtual/mcp-workers/issues/344#issuecomment-6488549684)).
PostgreSQL Hyperdrive E2E and PostgreSQL Direct plaintext E2E remain unperformed.
Spec #344 remains **Open**.

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

## Owner-triggered Hyperdrive Actions

The existing Owner-only `/setup` page can request `enable` or `retire` for a **disabled** Hyperdrive D1 reference. Each request is gated by the existing exact Owner Access identity, Origin and CSRF checks, revision validation, and exact ID confirmation for retirement. The Worker calls only the allowlisted `release.yml` GitHub `workflow_dispatch` endpoint on `main` with `deploy_to_production=false`. The existing protected Action independently verifies `github.actor=lirtual`, immutable main, Cloudflare binding/origin/CA/cache, live health or unbinding evidence, and D1 CAS. A GitHub 204 response confirms **request acceptance only**, not completion. The Owner Maintenance section also offers **Check GitHub Actions connection**: a CSRF-protected, non-destructive dispatch with `worker=database-mcp-worker`, `deploy_to_production=false` and all other approval flags false, so none of the existing `release.yml` jobs runs. This checks the deployed PAT's actual GitHub dispatch permission without modifying D1, any database, Hyperdrive, or the Worker. The Owner should inspect the GitHub Actions run separately; the page does not claim an end-to-end workflow success solely from 204.

The Owner page uses the **GitHub Environment Secret** `DATABASE_GITHUB_ACTIONS_TOKEN` under environment `database-mcp-worker`: a fine-grained, Owner-owned GitHub PAT restricted to repository `lirtual/mcp-workers` with only `Actions: Read and write`. The existing `release.yml` job uses `environment: database-mcp-worker`, stages this secret with the other selected-Worker credentials, and publishes it via Wrangler `--secrets-file`; it also verifies the required Cloudflare Secret binding after deployment. The PAT must not be separately maintained in the Cloudflare Dashboard. Never put this PAT into D1, public variables, page fields, logs, repository files, or GitHub workflow inputs. Missing or invalid credentials prevent the deployment before publication; a revoked or unauthorized token also fails closed at dispatch time, while existing SQL operations remain unaffected. This token can dispatch any permitted workflow within its repository scope, so limit and rotate its grant carefully. Passwords, CA PEM, TLS and database target changes remain Cloudflare-managed and out of scope for webpage dispatch. Binding removal requires a reviewed source change plus ordinary release **before** retirement is requested; the retirement job never removes Worker bindings or Cloudflare resources itself.

The Owner `/setup` page uses Cloudflare Access exact-email OTP, native Access identity with strict signed-JWT fallback, Origin/CSRF checks and throttling. Direct creation and sensitive credential edits require plaintext-risk acceptance. A logical ID must keep the same host/IP, port and database; changing target requires a new ID. Passwords, URLs, CA, keys and ciphertext are never displayed. PostgreSQL Direct requires explicit plaintext acceptance; live E2E remains unverified. Hyperdrive references enter D1 **disabled** and require protected Owner/main GitHub Actions activation with Cloudflare readback and a signed, bounded read-only Worker preflight **before** D1 becomes active. The private `/internal/hyperdrive-health` route requires existing MCP bearer auth plus a short-lived HKDF-derived HMAC proof from the existing Owner Actions encryption-key Secret; it accepts only a disabled Hyperdrive ID and exact revision, runs health only, never writes D1, and returns no secrets. Failed probes leave D1 disabled. MySQL Hyperdrive is now active; PostgreSQL Hyperdrive is still disabled.

**Important gate:** `hyperdrive-bindings.json` is the reviewed nonsecret binding/config-ID + origin/CA provenance mapping, containing the two reviewed Aiven test bindings. Each real entry must contain `binding`, `id`, `dialect`, `origin_host`, `origin_port`, `origin_database`, and `ca_certificate_id`. The origin password and PEM must NEVER appear in that file. The existing GitHub Actions release uses a read-only Cloudflare Hyperdrive GET (requires **Hyperdrive Read** on its existing token) both before and after deployment to compare the exact origin and CA, require PostgreSQL `verify-full` / MySQL `VERIFY_IDENTITY`, and require `caching.disabled=true`. The release preflight compares it against the reviewed Wrangler `hyperdrive` entries and readback checks the deployed IDs. Runtime rejects any missing or mismatched Binding. This alone **does not prove** source Hyperdrive configuration, CA trust, hostname validation, disabled query cache, pool restart, or rollback-version safety; these remain mandatory external verification gates before any Hyperdrive activation. No account-management token is embedded in the production Worker.

For MySQL Hyperdrive, the driver cannot use protocol-level prepared `execute()`. Structured writes use `query(sql, params)` only for primitive values and verify `NO_BACKSLASH_ESCAPES` is absent from the **same transaction/session immediately before interpolation**. This is **not a server-side parameter binding**, and deployed Workers escaping/injection/rollback tests remain P0 requirements. PostgreSQL Hyperdrive must respect transaction pooling. Never retry ambiguous non-idempotent commits.

The existing MCP tools remain: `list_connections`, `inspect_schema`, `get_schema_context`, `query_read`, `explain`, `health_check`, `insert_rows`, `update_rows`, `delete_rows`, `create_table`, `alter_table`, `create_index`, `drop_index`, `drop_table`. Existing row, result-byte, query-time and write-affected-row limits remain.

## Security and release checks

Direct public-host/DNS/address checks are retained, with documented DNS rebinding/TOCTOU residual risk. Never use Direct with a server requiring encrypted database traffic. Database GRANT/RLS and transactional engine properties remain the authorization and rollback boundaries.

The Worker requires `MCP_ACCESS_TOKEN`, `DATABASE_ENCRYPTION_KEY`, `DATABASE_KEY_ID`, `DATABASE_GITHUB_ACTIONS_TOKEN`, a dedicated D1 `DB` binding, `RATE_LIMITER`, `SETUP_RATE_LIMITER`, and the existing Owner Access Variables. Bounded CAS key rotation applies **only to encrypted Direct records**; retained rollback versions and backups must be compatible with both current and historic encryption keys.

For subsequent releases use only existing protected GitHub Actions with read-only D1/Access/binding gates and exact active-version checks; the old importer and legacy rollback dispatch are retired. For a sensitive Hyperdrive Cloudflare change: disable the logical connection, change the dedicated upstream config with approved access, restart/drain its native pool, verify **new connections** and TLS/caching/binding provenance, then explicitly enable. Failures remain disabled. To retire a Hyperdrive record, first disable it, review older rollback-version and external consumers, remove its Binding and manifest entry in a reviewed GitHub release, verify that release in production, then dispatch the existing protected Release Worker with `database_hyperdrive_retire_approved`, exact ID and revision. The guarded job verifies unbound current production, CAS-deletes only the disabled D1 record, and confirms permanent ID retirement; it never deletes Cloudflare config/CA. The Owner separately reviews old versions, other consumers and CA dependencies before any upstream resource deletion. Do not add auto-cleanup or another orchestrator.

```bash
pnpm --filter database-mcp-worker check
node --test scripts/manual-worker-release.test.mjs
```

Unit tests and dry-run are not deployed Workers acceptance. MySQL Direct and MySQL Hyperdrive have separate production E2E evidence. PostgreSQL Hyperdrive remains disabled pending protected activation and live E2E; PostgreSQL Direct lacks an accepted plaintext origin. Both Aiven hosts passed origin-side CA and hostname negatives, which do not replace deployed Workers TLS-negative acceptance. Real production writes and DDL were exercised only against a dedicated test table and cleaned up; no authorization to modify existing business tables follows. See [production cutover and rollback](../../docs/database-cutover-344.md), [historical Direct TLS investigation](docs/direct-tls-feasibility.md), and [Spec #344](https://github.com/lirtual/mcp-workers/issues/344).

## License

MIT; upstream provenance retained in `LICENSE` and `SOURCE.md`.
