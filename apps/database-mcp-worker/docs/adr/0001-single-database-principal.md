# ADR-0001 — One database principal per logical connection

Status: **Accepted as an architectural direction; implementation pending**. Date: 2026-10-13.
Decision input: cross-Worker grilling round 1 Q2=B. Related: [cross-Worker approval ADR](../../../../docs/tool-authorization/adr/0001-delegate-tool-approval-to-client.md).

## Context

The existing Database MCP configuration distinguishes `read`, `write`, and `admin` connection credentials and resolves those credentials separately. That model requires multiple independently configured database accounts or DSNs for a logical database. The operator wants a private, simple MCP setup and has decided that the client (such as ChatGPT) should own user-facing tool approval rather than Worker-specific permission controls.

Separate database principals are a resource-level privilege boundary rather than a client-tool approval. Eliminating their separation trades credential least-privilege isolation for easier configuration and operation. This is a deliberate design decision.

## Decision

1. Model each **logical database connection** with **one upstream database principal/credential**, regardless of the type of SQL operation requested. Multiple logical connections may continue to point to different databases with different credentials; there is no global credential shared across unrelated databases.
2. Eliminate the distinct `read` / `write` / `admin` credential configuration and resolution paths once the migration design is approved and implemented. The single credential's **actual MySQL/PostgreSQL grants** determine which statements can run; do not auto-grant privileges, substitute elevated credentials or provide an escalation fallback.
3. Do not turn client approval into server-issued database privileges. Continue to authenticate MCP access at ingress.
4. The choice of **MCP tool surface** (separate read/write/DDL tools versus general SQL execution) remains an explicit next-round decision; this ADR does not authorize unrestricted SQL, multi-statement queries, stored procedures, or bypassing execution bounds.
5. Preserve standard input validation, resource limits, failure reporting, non-replay of uncertain mutations and secret-safe observability unless separately agreed. The exact contract is to be decided later.

## Consequences

**Positive:** fewer DSN/secret entries; no separate credential-resolution paths for read, write and schema tasks; more predictable deployment configuration.

**Negative:** the one configured account may now hold powerful permissions; token compromise, prompt injection or an over-authorized client can cause changes formerly blocked by a separate read-only principal. A mistaken destructive operation could affect live data. Client-level confirmation is not guaranteed for every request or across MCP clients.

**Operational:** existing READ/WRITE/ADMIN configurations require an explicit migration and compatibility plan. Previously separate connection values must not be silently replaced or merged. Deployment, grant changes and secret rotation are separate actions.

## Supersession scope

This decision supersedes the *credential separation* aspect of `apps/database-mcp-worker/docs/safe-admin-v0.3.md` after implementation. It does not retroactively change that document's descriptions of the deployed implementation, nor decide to keep or remove Safe Admin's tool schemas.

## Non-decisions

- No current database user or permission is changed.
- No migration code, production Worker, runtime secret or database schema has been modified.
- No decision that one credential implies superuser or administrator access.
- No assumption that all connected MCP clients require user confirmation.
