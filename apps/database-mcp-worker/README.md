# Cloudflare Database MCP Worker

A Cloudflare-native MCP server for bounded PostgreSQL/MySQL reads, structured Safe Write and Safe Admin/DDL. **This README describes the unmerged [Spec #344](https://github.com/lirtual/mcp-workers/issues/344) Draft implementation; it does not describe an approved production cutover.** See [the cutover/rollback checklist](../../docs/database-cutover-344.md).

## Current deployment status

**Production cutover: BLOCKED.** The existing production Worker continues using its original `DATABASE_CONFIG` Secret until a separately authorized, verified migration. Do not remove, rotate or overwrite that existing Secret in preparation for this Draft. Do not invoke the Database production release workflow while its dedicated D1/Access/TLS gates are incomplete.

The Draft moves the live connection catalog to a **dedicated D1 database**: one AES-256-GCM encrypted record per logical connection. Every SQL tool reads that record on admission, checks that it is active, and uses the selected connection's own database principal. A disabled/missing ID fails explicitly; there is no plaintext or Hyperdrive fallback.

## Secrets, bindings, and Owner access

The Draft release requires the following Worker Secrets:

- `MCP_ACCESS_TOKEN` — the existing Cloudflare MCP Portal-to-Worker Bearer credential.
- `DATABASE_ENCRYPTION_KEY` — canonical 32-byte Base64 AES-GCM key, independent of other Workers.
- `DATABASE_KEY_ID` — key identifier, with optional matching previous key/ID retained for D1 backup and rollback compatibility.

Before any separately approved deployment, create and approve the dedicated `database-mcp-db` D1 and bind it as `DB`. The reviewed schema lives under `migrations/`; release checks are **read-only** and must not implicitly create or import D1 data. Keep existing encrypted backups and historical keys for their retention period.

Owner management uses a dedicated HTTPS custom domain and a separate **self-hosted Cloudflare Access OTP** application, restricted to exactly the Owner email. Required plaintext Access configuration: `DATABASE_SETUP_HOST`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, and `OWNER_EMAIL`. The setup hostname/route comes from reviewed Wrangler configuration, not arbitrary GitHub variable overrides. The release gate verifies the domain, audience, one precise email policy, OTP-only identity provider, and short session. The MCP Bearer credential cannot authorize Owner setup.

The setup UI is a small server-rendered `/setup` page. It shows only non-secret ID, dialect, status and revision; the password, complete URL, CA material, encryption keys and ciphertext are never echoed. New and edited records are validated for eligible public endpoints and must pass verified TLS health before activation. Unreachable but structurally valid candidates may be saved **disabled**, not enabled. Edits, status changes, deletion and bounded key rotation enforce optimistic revision checks. Delete requires disabled status and explicit confirmation; it never deletes the upstream database.

## Direct TLS requirement

- PostgreSQL accepts `postgres://` / `postgresql://` with an explicit database.
- MySQL accepts `mysql://` with an optional database name; operations requiring a schema must name it when the connection URL omits a default database.
- Driver-level URL query parameters that could override SSL policy are rejected. MySQL Direct TLS requires a DNS hostname; IP literals are refused until peer identity validation is proven.
- Both drivers must verify the server certificate chain and peer DNS identity. Optional validated project CA material is encrypted per connection.
- **P0 acceptance requires actual Cloudflare Workers Direct TLS against separately approved disposable MySQL and PostgreSQL databases**, including reads, writes, health, DDL, and negative certificate/hostname/plaintext cases. Successful Node.js CI, dry-run, or an offline TLS mock **is not** proof.
- Dynamic DNS validation rejects local/private/reserved targets but does not pin the DNS result to the driver's outgoing socket. Residual DNS rebinding/TOCTOU risk is documented; never claim full SSRF isolation.

No proxy, custom database-protocol implementation, Hyperdrive restoration, TLS downgrade or direct plaintext fallback is approved.

## MCP tools

The existing names and structured permissions remain:

| Read and inspect | Safe Write | Safe Admin / DDL |
| --- | --- | --- |
| `list_connections`, `inspect_schema`, `get_schema_context`, `query_read`, `explain`, `health_check` | `insert_rows`, `update_rows`, `delete_rows` | `create_table`, `alter_table`, `create_index`, `drop_index`, `drop_table` |

`list_connections` returns only non-secret metadata and works with an empty catalog. With exactly one configured connection, the `connection` argument can be omitted. With multiple configured IDs, a caller must provide one even when only one is active.

Safe Write accepts structured operations, not raw mutation SQL. UPDATE/DELETE use bounded transactions and roll back changes above the affected-row cap. Structured DDL uses database-native permissions and explicit targets; it is not automatically retried after ambiguous results. Existing row/schema/result byte caps and query timeouts remain enforced. PostgreSQL RLS and native grants are the final permissions boundary; MySQL transactional rollback requires a transactional engine such as InnoDB.

## Limits and tests

Runtime defaults: `MAX_ROWS=500` (maximum 5,000), `MAX_RESULT_BYTES=1048576` (maximum 8 MiB), `MAX_SCHEMA_BYTES=524288` (maximum 4 MiB), `QUERY_TIMEOUT_MS=15000` (maximum 60,000), `MAX_WRITE_AFFECTED_ROWS=20` (maximum 100). The registry allows **0–50** logical connections, with an atomic insertion cap.

```bash
pnpm install --frozen-lockfile
pnpm --filter database-mcp-worker check
```

CI also uses isolated disposable MySQL/PostgreSQL containers with certificate-verified TLS and exercises the SQL tools. These fixtures are **not** production databases. Production compatibility must be tested independently in a real deployed Workers runtime.

The old whole-catalog JSON parser remains only for **offline, independently authorized source migration and test fixtures**; it rejects legacy Hyperdrive records and is not connected to HTTP/MCP runtime admission. The migration helper imports records disabled and verifies every encrypted readback without querying the upstream SQL servers. Every legacy ID must separately pass real TLS health and receive explicit cutover approval before activation.

**Never test, health-check, modify or connect to `scrape_relay` or `b2b` during this work.** Do not copy their credentials to temporary fixtures. Preserve the old production Worker, original Secret, and rollback recovery materials until expressly authorized otherwise.

## License and provenance

MIT license and upstream source provenance remain in `LICENSE` and `SOURCE.md`.
