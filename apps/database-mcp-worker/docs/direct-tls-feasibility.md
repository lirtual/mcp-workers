# Spec #344 — Direct TLS feasibility gate (incomplete)

**Release state: BLOCKED. This is not a TLS acceptance certificate or production-ready design.**

## Actual deployed Workers Aiven result (2026-10-27)

**P0 FAILED; do not deploy or merge.** Disposable Aiven-only Workers tests were run using GitHub Actions:

- [Run 40488616910](https://github.com/lirtual/mcp-workers/actions/runs/40488616910): disposable Worker published; probe endpoint request failed.
- [Run 40488935091](https://github.com/lirtual/mcp-workers/actions/runs/40488935091): disposable Worker published; the real Worker returned MySQL `ERR_OPTION_NOT_IMPLEMENTED` and PostgreSQL an unclassified `runtime_failure`. Neither dialect passed read/write/DDL or verified certificate-negative gates.
- [Run 40494149234](https://github.com/lirtual/mcp-workers/actions/runs/40494149234): one-time follow-up on the disposable Aiven fixtures. MySQL failed at `mysql_connect` (`ERR_OPTION_NOT_IMPLEMENTED`, `unsupported_api`); PostgreSQL failed at `postgres_connect` (`connection_terminated`, unknown code). Only static, redacted failure stages and categories were logged. The proof Worker was removed and independently confirmed absent in Cloudflare inventory.
- The locked `mysql2@3.24.4` `lib/base/connection.js` `startTLS` calls `Tls.connect` with `checkServerIdentity` supplied in its option object. Cloudflare's [compatibility contract](https://developers.cloudflare.com/workers/configuration/compatibility-flags/) states unsupported `checkServerIdentity` TLS options throw `ERR_OPTION_NOT_IMPLEMENTED` by default. This gives a concrete compatibility hypothesis consistent with the actual MySQL failure. It does **not** prove that deleting the option or disabling the runtime rejection preserves verified TLS; never suppress the error by relaxing the TLS safety policy.
- Runtime CA PEM inputs were empty. PostgreSQL's exception was not yet classified, and Aiven CA chain verification, hostname mismatch rejection and TLS-only server-side enforcement have not been proven.
- The disposable test workflow/handler were removed from the branch after the runs. The cleanup steps were successful; independent Cloudflare Worker inventory subsequently confirmed the test script no longer exists.

Under Q20=B this is a **release-blocking** feasibility result. Keep the current transport design unchanged until a small verified, secure driver adaptation is demonstrated or the Owner separately approves a new architecture decision. Production cutover remains prohibited. Legacy business endpoints were not contacted.


- 2026-10-27: Reused mysql2 and pg, consolidated each driver's construction into one shared connection factory across read, health, structured write and DDL. Direct connection factories now request certificate verification and host verification (mysql2). Connection-string TLS/downgrade overrides are refused; PostgreSQL options are passed explicitly, rather than as a connection string that can override `ssl`.
- MySQL IP-literal destinations are currently rejected even if public: the inspected mysql2 handshake skips DNS identity verification for IP literals. A future IP-SAN-capable implementation would need an independent proof and test.
- Unit tests, TS typecheck, ESLint and Wrangler dry-run passed locally. These prove option construction, not that real DB TLS negotiation works.
- Bounded *local workerd* probe (`wrangler 4.130.0`, compatibility date `2026-09-12`) upgraded `node:net` TCP to `node:tls` against `www.google.com:443`, verified the public certificate and returned `{ "result": "verified" }`. Temporary probe file and running Worker were removed. This probes Node TLS socket wrapping only, **not mysql2/MySQL negotiation, PostgreSQL negotiation or actual Cloudflare deployment**.
- Official Cloudflare MySQL Workers tutorial (updated 2026-10-12) reports current MySQL drivers depend on unsupported Node.js secure-connection APIs for Direct connections: https://developers.cloudflare.com/workers/tutorials/mysql/ . The local socket wrapping result cannot override the upstream warning.

## 2026-10-27 — historical pre-provisioning inventory (superseded)

**Historical snapshot only.** The inventory below predates dedicated D1 provisioning and the real Workers TLS tests described above. Do not use it as current status.

The latest **unmerged Draft PR #345** revision `43320c7` passed [GitHub CI #40469802259](https://github.com/lirtual/mcp-workers/actions/runs/40469802259): application checks, disposable MySQL/PostgreSQL integration, required gate and GitGuardian. This establishes only Node.js/CI compatibility; **no deployed Cloudflare Worker has completed the required database TLS handshake**.

The current official [Cloudflare MySQL tutorial](https://developers.cloudflare.com/workers/tutorials/mysql/) (last updated October 12, 2026) explicitly warns that **direct MySQL driver TLS uses unsupported Node.js APIs that prevent secure connections without Hyperdrive**. Cloudflare separately [documents supported Node TLS functions](https://developers.cloudflare.com/workers/runtime-apis/nodejs/tls/), but support for standalone `node:tls` does not prove that mysql2's mid-stream MySQL TLS upgrade works. Treat MySQL Direct TLS as a **specific unresolved P0 compatibility risk**, not as proven impossible or already successful. Do not switch the project to Hyperdrive, a proxy, a new Worker, plaintext or a custom wire-protocol implementation without a new architecture decision.

Read-only current account inventory and MCP connection metadata show:

- No dedicated disposable Aiven MySQL or PostgreSQL connection is available for the acceptance workflow; the existing Database MCP connection list contains **only the two forbidden-to-test legacy business IDs**. Their credentials and endpoints were not read, tested or probed.
- Cloudflare lists eight D1 databases, but no approved `database-mcp-db`. The existing "Database" Access application is an MCP app rather than the separate self-hosted Owner Setup OTP app; no Database Owner custom domain is present.
- None of the required dedicated D1, Owner Access, or production cutover resources has been provisioned as part of #344.

**Next valid proof step:** Provision **two newly named disposable Aiven fixtures** (one MySQL, one PostgreSQL), with independent least-privilege test users, TLS-only endpoints and approved CA/hostnames. Put their credentials in an approved secret store, not a PR, issue, workflow log or chat. Only after separately authorizing the testing deployment, run bounded read, health, Safe Write, structured DDL, certificate/hostname-negative and no-plaintext-downgrade acceptance against *those fixtures from a real deployed Cloudflare Workers runtime*. Keep the production Database Worker and its old `DATABASE_CONFIG` unchanged.

If a dialect cannot satisfy certificate-verified Direct TLS with the existing driver or a **small, demonstrably correct** adaptation, capture the redacted failing runtime stage and stop for a new architecture decision. A green CI result, a local workerd socket smoke, or fixture success for the other dialect cannot replace this P0 gate. Even success for both new fixtures does **not** authorize migration or TLS probing of the old business databases, which remain explicitly prohibited.

## Unmet mandatory P0 gate

Against **TLS-only nonproduction MySQL and PostgreSQL fixtures in the actual deployed Cloudflare Workers runtime**, separately demonstrate trusted CA, hostname checks, expired/mismatched/untrusted certificate rejection, no plaintext downgrade, plus read, health, structured write and structured DDL end to end for each driver. Record versions, reproducible steps and redacted evidence. Failure of either dialect means stop and revisit architecture; no proxy or Hyperdrive fallback under this Spec.

**Current 2026-10-27 status:** Dedicated `database-mcp-db` exists with registered `0001_connections.sql` and an empty registry. Three disposable Workers probes ran, failed the mandatory Direct TLS gate and were removed. The production Worker retains `DATABASE_CONFIG` and still has no D1 `DB` binding. Do not merge or release this Draft before verified Workers TLS, Owner browser acceptance, authorized migration and safe cutover.

## D1 branch-only implementation (not a cutover)

- Draft PR #345 contains the dedicated D1 schema, a 50-entry INSERT cap enforced in the SQL statement, revision/CAS-based updates and disabled-only deletion, and AES-GCM protected per-record credentials. MCP tooling now uses D1 for fresh operation admission; missing D1 is an error, not an implicit empty catalog, while a deliberately empty valid registry is accepted by `list_connections`.
- Before each eligible connection admission, a public DNS lookup checks A and AAAA responses. Obvious private/reserved network answers fail closed. It **does not pin the DNS answer to the driver socket**, so DNS rebinding/TOCTOU remains a documented residual risk; Workers egress restrictions remain essential. MySQL IP-literal endpoints remain rejected because current mysql2 does not verify the IP SAN in its observed path.
- A callable, bounded (maximum 10 per batch) internal re-encryption routine can resume from partial progress and uses ciphertext/key-id/revision CAS to avoid overwriting concurrent edits. It is exposed through the Access-protected `/setup/rotate` route on this branch, but has not been verified against deployed D1 or real Cloudflare Access. Historical/manual backup and D1 Time Travel recovery-key retention is not automated and must be satisfied before key cleanup.
- Server-rendered Owner forms, server-verified Access JWT/CSRF, per-owner throttling, connection health gating and fail-closed error contracts are now implemented and have local unit and signed-JWT tests. **Real Access, D1 write, record lifecycle and authenticated ingress acceptance remain unverified**. The migration command, production D1 binding, release-secret transition, legacy retirement and controlled rollback are still not implemented. There is no authorized production D1 provisioned for this release, and no safe main-branch deployment route for the partial code.
- GitHub Actions CI fixtures now generate a disposable CA and hostname SAN certificates for both SQL engines, reload server TLS and require secure transport. Workflow #40446673955 demonstrated 17/19 existing integration tests passing over verified TLS; two legacy native-permission probes were correctly blocked because they still disabled SSL. Commit `2b1de15` updates those probes to verified TLS, with re-run pending at documentation time. These are **Node 24 CI** connections, NOT deployed Workers compatibility evidence.
