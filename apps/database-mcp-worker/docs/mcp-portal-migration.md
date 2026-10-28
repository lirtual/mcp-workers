# Database MCP Portal and connection management · Spec #344

**Implementation Draft; production cutover blocked.** Historical pre-D1 `DATABASE_CONFIG` flat-catalog instructions are obsolete for the new design. Do not run `wrangler secret put DATABASE_CONFIG` or change the live catalog; the old deployed Secret must be retained unchanged until separately authorized migration and verification.

## Ingress and identity

```text
MCP client
  → existing Cloudflare MCP Portal
  → Worker /mcp (MCP_ACCESS_TOKEN Bearer)
  → active logical connection in dedicated D1
  → Direct plaintext SQL origin OR dedicated Hyperdrive strict-TLS origin
  → database-native grants / PostgreSQL RLS / ownership
```

Portal Bearer authorizes **MCP only**, never Owner configuration. The Worker has no independent resource-server OAuth/JWKS, browser OAuth, or SQL privilege promotion. The existing tools still separate bounded read, structured Safe Write, and controlled DDL; mutating queries and arbitrary SQL remain unavailable through `query_read`.

Owner `/setup` is a separate Cloudflare Access exact-email OTP/JWT, Host, Origin and CSRF boundary. Sensitive secrets never appear in HTML or the MCP catalog. Each logical ID picks one dialect, transport, status, revision, and native database principal. With one configured entry a connection ID may be omitted; with multiple, it is mandatory. Zero entries is an empty catalog, not configuration failure. Disabled, missing, invalid or unverified records fail closed.

## Database references and activation

- **Direct:** D1 encrypts the actual URL with dedicated AES-GCM key/ID. Transport is **plaintext TCP** by explicit Owner exception. Creating or replacing origin/credentials requires the risk acknowledgment. Never infer TLS from a UI CA field.
- **Hyperdrive:** D1 contains non-secret `config_id` and `binding_name` only. A dedicated Cloudflare Hyperdrive configuration owns passwords, CA, strict origin hostname validation and disabled caching. The protected Wrangler configuration and versioned `hyperdrive-bindings.json` must be identical, and actual Worker bindings must independently match on readback.
- **Add / enable:** Hyperdrive candidates start disabled; all actual TLS, credentials, caching and pool behavior remain blocked pending independent Cloudflare and deployed Workers verification. A missing Binding never becomes Direct.
- **Delete:** Disable via revision CAS, unbind in the authorized existing GitHub Actions workflow, verify live and rollback-compatible versions, then retire the ID. Never auto-delete a potentially shared CA or upstream SQL account.

## Security and acceptance

All 14 existing MCP tools retain bounded SQL parsing, response limits, controlled writes, annotations and native-privilege isolation. Both transports must pass health, read/schema/explain, Safe Write with rollback, controlled DDL and negative cases in real deployed Workers for **both MySQL and PostgreSQL**. MySQL Hyperdrive uses restricted client interpolation with transaction-bound SQL Mode guard; `COM_STMT_PREPARE` is unavailable. `NO_BACKSLASH_ESCAPES` must fail closed on the actual session.

The existing production `DATABASE_CONFIG` Worker currently remains unchanged. New D1-backed implementation cannot be released until independently authorized migration, unchanged legacy inventory verification, application of `0002`, correct keys/backups, Cloudflare Access controls, Hyperdrive provenance, four-path acceptance, and actual Portal/Owner readback. Never use `scrape_relay` or `b2b` for connection probes or SQL without fresh specific approval.

See [Worker README](../README.md), [cutover/rollback checklist](../../../docs/database-cutover-344.md), and [Issue #344](https://github.com/lirtual/mcp-workers/issues/344). Use only existing manual GitHub Actions releases when explicitly authorized; no PR or push automatically publishes the production Worker.
