# Database MCP

Database MCP serves authenticated `/mcp` requests using stable logical connection IDs. Other paths, including `/setup` and `/internal/hyperdrive-health`, return 404. MCP Portal authentication, per-principal/connection rate limits, SQL read guards, row/time/byte limits, structured writes/DDL and database-native permissions remain enforced.

## Connection configuration (Spec #760)

GitHub Environment Variable `DATABASE_CONNECTIONS` is the sole logical catalog: a flat JSON object containing zero to ten unique IDs. Each value is one Direct URI (`mysql://` or `postgresql://`) or `hyperdrive://HYPERDRIVE_BINDING`. IDs use 1–64 ASCII letters/digits/underscore/hyphen, starting with a letter or digit. Removed IDs fail deterministically; multiple IDs require explicit selection.

```json
{"b2b":"mysql://user:${DATABASE_B2B_PASSWORD}@#{DB_HOST}:3306/b2b"}
```

This is a synthetic example. Passwords must be a whole `${NAME}` Secret reference, never a literal. `#{NAME}` is a nonsecret Variable reference. Resolution is single-pass, component-aware and nonrecursive; URI-reserved password characters are encoded safely. Missing/empty/unapproved references, query options, fragments, duplicate IDs and unsupported schemes fail closed. Neither expanded URIs nor credentials are returned or logged.

Approved references live in `connection-references.json`. The existing selected-Worker release explicitly maps `DATABASE_B2B_PASSWORD` and `DATABASE_SCRAPE_RELAY_PASSWORD` as independent Secrets, and `DB_HOST` as a Variable. Only referenced names are staged. Adding a name requires reviewing that allowlist **and** its explicit GitHub Actions expression in both staging steps. `MCP_ACCESS_TOKEN` remains required; SQL limit Variables retain their `DATABASE_*` names from #733. #760 supersedes #733 only for Database Setup/D1/encryption/dispatch configuration; other Workers and shared Repository settings retain their own contracts.

Direct connections retain the existing explicit plaintext TCP policy and public DNS/IP admission with pinned dial addresses. This change adds no Direct TLS or private-network capability.

Hyperdrive configs, credentials, TLS and rotations are managed natively in Cloudflare. Declare bindings in Wrangler and the reviewed `hyperdrive-bindings.json` using only `binding`, `id`, `dialect` and MySQL `origin_database`. Worker proxy fields supply connection credentials. Protected release reads the config to require strict origin certificate/hostname verification and disabled query caching, plus matching dialect/MySQL schema. The current reviewed manifest is empty. No Actions job provisions or mutates Hyperdrive.

## Cutover and recovery

Source changes are not production acceptance. Before a separately authorized release, independently inspect main/CI, active Worker version/bindings, actual logical IDs/transports/permissions, old Registry and unfinished Hyperdrive operations. Stop for Unknown operations or missing rollback dependencies. Compare intended inventory with current production; preserve `b2b` and `scrape_relay` if still active. Historical README inventories are not current evidence.

The Owner manually supplies existing Direct passwords as the independent GitHub Environment Secrets through a separately authorized configuration action. No D1 password extraction, rotation or generated replacement is provided. Secret metadata does not prove byte equality.

Use only existing protected **Release Worker**, selecting `database-mcp-worker` with exact `database_expected_release_sha` and production authorization. Staging validates the entire catalog before deploy, retaining unresolved Secret references in the plain Variable and placing each credential in `secret_text`. Verify exact active version, catalog, binding IDs/types and referenced Variables after publication. Normal Wrangler releases preserve omitted legacy Secrets; their presence is recovery compatibility, not cleanup success.

After an authorized release, independently verify authenticated `list_connections`, health and bounded `SELECT 1` for reviewed active connections, plus Portal/auth denial semantics. Record code/CI, protected release, real DB and Portal statuses separately. No business-data write is required.

D1 durable in-flight/Unknown accounting has been **removed**, without replacement or equivalent cross-request drain guarantees. Unknown SQL completion remains Unknown and must never be automatically replayed. Native Hyperdrive changes require independent review of active connections, older versions and rollback paths.

Applied `migrations/` remain historical. Preserve external D1 ciphertext, old encryption keys, eligible Worker versions and Hyperdrive/CA resources for recovery. Code rollback alone cannot restore deleted bindings or keys. Physical Cloudflare/GitHub cleanup, Portal changes and production publication each require separate authorization. See [historical recovery evidence](../../docs/database-cutover-344.md).

## Local development

The pinned Wrangler filters `.dev.vars` to declared Secrets when `secrets.required` is present. Production intentionally requires only `MCP_ACCESS_TOKEN`; `deploy --secrets-file` can upload additional referenced passwords. A password placed in `.dev.vars` alone is therefore insufficient for local `wrangler dev`.

For local Direct connections, copy `wrangler.jsonc` to the ignored `wrangler.local.jsonc` in this app directory. Set its synthetic/development `vars.DATABASE_CONNECTIONS` and referenced nonsecret Variables. In **that local file only**, extend `secrets.required` with exactly the approved password names referenced by your local catalog, for example `["MCP_ACCESS_TOKEN", "DATABASE_B2B_PASSWORD"]`. Put the corresponding values in ignored `.dev.vars`, then run `pnpm exec wrangler dev --local --config wrangler.local.jsonc`. Keep password values out of the config and CLI arguments. Do not change production's required list or require unused connection passwords. Default `pnpm dev` retains the empty source catalog. Public-endpoint admission remains enforced in local development.

The runtime regression derives its fixture from the actual source config: it first proves that an undeclared optional `.dev.vars` password is rejected, then verifies this local-only declaration. Its production dry-run separately verifies extra Secrets in `--secrets-file`. The real database MCP integration exercises the new catalog/admission/tool path with actual PostgreSQL/MySQL SQL; only synthetic public-address TCP destinations are mapped to isolated loopback fixtures at the driver boundary. This does not prove public networking or deployed Workers database connectivity.

## Verification

`pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm lint` and `pnpm deploy:dry-run`. Integration tests use isolated local MySQL/PostgreSQL services. CI also exercises protected release contracts and the local Workers runtime. Local checks do not establish production readiness.
