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
