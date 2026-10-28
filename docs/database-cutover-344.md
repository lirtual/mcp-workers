# Database MCP #344 — Fresh registry release and recovery

## Current Owner decision (2026-10-28)

**No migration of historical connection data.** The former two-record import,
protected atomic Direct activation and any prerequisite that `b2b` or
`scrape_relay` already exist in the new D1 are superseded. The historical
imported D1 **must not** be read, imported again, modified or deleted in this
release. Do not invoke any historical activation jobs against it.

New dedicated empty D1: `database-mcp-registry`
(`cbfe6a05-4979-4e6a-9cc2-4f6468586e4a`). Legacy D1 `database-mcp-db`
(`8853a6ac-beaa-45aa-bdb2-0867e6f3df6d`) remains untouched. As of
2026-10-28, the new D1 was created but its schema **has not been applied**.
The original Worker `eb3f4823-124b-4d76-abdc-42f85097bb5a` remains the
production deployment with original `DATABASE_CONFIG` Secret.

## Safe release order

1. Review and merge PR #345 only after the existing CI accepts fresh-registry
   runtime, Owner CRUD, read-only release checks, and preserved legacy recovery.
2. Via the **existing** `Release Worker` workflow on unchanged `main`, use
   `worker=database-mcp-worker`, `database_prepare_approved=true`, and
   `deploy_to_production=false` to apply **only** the existing two migrations to
   `database-mcp-registry`. Do not import or open historical connection data.
3. Use the existing read-only fresh-registry preflight to confirm that the new
   D1 has both migrations, zero connections and zero retired IDs, and that the
   original Worker with `DATABASE_CONFIG` is still available for recovery.
4. An explicitly approved production Worker release via **existing** GitHub
   Actions binds the **new D1**, retains encrypted-key requirements and Owner
   Cloudflare Access policy, and must pass protected source/binding/version
   checks. No new CI, deployment system or Acceptance environment.
5. **Planned configuration gap:** at first deployment the new Worker has zero
   connections; existing Database MCP queries to the former logical IDs are
   unavailable until the Owner reconfigures them. This gap is accepted by the
   Owner. In `https://database.lirtual.dpdns.org/setup` use the OTP-protected
   Owner UI to add required MySQL Direct IDs one at a time, confirm explicit
   plaintext transport acknowledgement, and complete approved production
   connection checks. **Do not copy old credentials to GitHub, issues or logs.**
6. If the new Worker release fails, use the separately authorized and
   readback-verified pinned legacy Worker version recovery. Preserve the old
   `DATABASE_CONFIG` and original Worker version; do not mutate either D1 in
   an attempt to recover.

Initial runtime scope is **MySQL Direct only**, with the existing explicit
plaintext warning, public-endpoint restrictions, Owner CSRF and OTP, admission,
rate limiting, AES-GCM encryption at rest, identity immutability, 10-connection
limit and retired-ID nonreuse. PostgreSQL Direct and Hyperdrive require
separate acceptance and code release; no compatibility toggle enables them.

The old import/activation scripts and any prior issue comments are **historical
artifacts, not executable steps for this plan**. The initial worker release
must never depend on historical imported D1 rows. Passing CI or schema checks
is not proof of production connection E2E.
