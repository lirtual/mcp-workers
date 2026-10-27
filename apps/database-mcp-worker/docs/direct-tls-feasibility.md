# Spec #344 — Direct TLS feasibility gate (incomplete)

**Release state: BLOCKED. This is not a TLS acceptance certificate or production-ready design.**

- 2026-10-27: Reused mysql2 and pg, consolidated each driver's construction into one shared connection factory across read, health, structured write and DDL. Direct connection factories now request certificate verification and host verification (mysql2). Connection-string TLS/downgrade overrides are refused; PostgreSQL options are passed explicitly, rather than as a connection string that can override `ssl`.
- MySQL IP-literal destinations are currently rejected even if public: the inspected mysql2 handshake skips DNS identity verification for IP literals. A future IP-SAN-capable implementation would need an independent proof and test.
- Unit tests, TS typecheck, ESLint and Wrangler dry-run passed locally. These prove option construction, not that real DB TLS negotiation works.
- Bounded *local workerd* probe (`wrangler 4.130.0`, compatibility date `2026-09-12`) upgraded `node:net` TCP to `node:tls` against `www.google.com:443`, verified the public certificate and returned `{ "result": "verified" }`. Temporary probe file and running Worker were removed. This probes Node TLS socket wrapping only, **not mysql2/MySQL negotiation, PostgreSQL negotiation or actual Cloudflare deployment**.
- Official Cloudflare MySQL Workers tutorial (updated 2026-10-12) reports current MySQL drivers depend on unsupported Node.js secure-connection APIs for Direct connections: https://developers.cloudflare.com/workers/tutorials/mysql/ . The local socket wrapping result cannot override the upstream warning.

## Unmet mandatory P0 gate

Against **TLS-only nonproduction MySQL and PostgreSQL fixtures in the actual deployed Cloudflare Workers runtime**, separately demonstrate trusted CA, hostname checks, expired/mismatched/untrusted certificate rejection, no plaintext downgrade, plus read, health, structured write and structured DDL end to end for each driver. Record versions, reproducible steps and redacted evidence. Failure of either dialect means stop and revisit architecture; no proxy or Hyperdrive fallback under this Spec.

No test Worker/resource provisioning, credential use/rotation, migration, D1 creation, production deployment, or legacy cleanup was authorized or performed in this slice. Do not stage or release this incomplete branch: registry, owner setup, crypto, Access and release-chain changes are not implemented yet.

## D1 branch-only implementation (not a cutover)

- Draft PR #345 contains the dedicated D1 schema, a 50-entry INSERT cap enforced in the SQL statement, revision/CAS-based updates and disabled-only deletion, and AES-GCM protected per-record credentials. MCP tooling now uses D1 for fresh operation admission; missing D1 is an error, not an implicit empty catalog, while a deliberately empty valid registry is accepted by `list_connections`.
- Before each eligible connection admission, a public DNS lookup checks A and AAAA responses. Obvious private/reserved network answers fail closed. It **does not pin the DNS answer to the driver socket**, so DNS rebinding/TOCTOU remains a documented residual risk; Workers egress restrictions remain essential. MySQL IP-literal endpoints remain rejected because current mysql2 does not verify the IP SAN in its observed path.
- A callable, bounded (maximum 10 per batch) internal re-encryption routine can resume from partial progress and uses ciphertext/key-id/revision CAS to avoid overwriting concurrent edits. It is **not exposed to an Owner route yet**. Historical/manual backup and D1 Time Travel recovery-key retention is not automated and must be satisfied before key cleanup.
- The Owner management UI, Access authentication, CSRF, public URL health gating, migration command, D1 binding, release-secret transition, legacy retirement and controlled rollback are **not yet implemented/verified**. There is no authorized production D1 provisioned for this release, and no safe main-branch deployment route for the partial code.
- The existing PostgreSQL/MySQL CI integration service fixtures use local IP addresses and no hardened TLS-only trust setup. They now fail, correctly, against the new fail-closed policy. Do not waive those failures or weaken the application to satisfy the old fixtures. Replace the fixtures with TLS-only SAN/trusted CA fixtures and rerun the integration suite in addition to the mandatory actual Workers test.
