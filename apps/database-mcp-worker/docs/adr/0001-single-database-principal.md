# ADR-0001 — One database principal per logical connection

Status: **Accepted as an architectural direction; implementation pending**. Date: 2026-10-13. Q2=B, Q4=A and Q7=A confirmed.
Decision input: cross-Worker grilling round 1 Q2=B. Related: [cross-Worker approval ADR](../../../../docs/tool-authorization/adr/0001-delegate-tool-approval-to-client.md).

## Context

The existing Database MCP configuration distinguishes `read`, `write`, and `admin` connection credentials and resolves those credentials separately. That model requires multiple independently configured database accounts or DSNs for a logical database. The operator wants a private, simple MCP setup and has decided that the client (such as ChatGPT) should own user-facing tool approval rather than Worker-specific permission controls.

Separate database principals are a resource-level privilege boundary rather than a client-tool approval. Eliminating their separation trades credential least-privilege isolation for easier configuration and operation. This is a deliberate design decision.

## Decision

1. Model each **logical database connection** with **one upstream database principal/credential**, regardless of the type of SQL operation requested. Multiple logical connections may continue to point to different databases with different credentials; there is no global credential shared across unrelated databases.
2. Eliminate the distinct `read` / `write` / `admin` credential configuration and resolution paths once the migration design is approved and implemented. The single credential's **actual MySQL/PostgreSQL grants** determine which statements can run; do not auto-grant privileges, substitute elevated credentials or provide an escalation fallback.
3. Do not turn client approval into server-issued database privileges. Continue to authenticate MCP access at ingress.
4. **Q4=A:** Retain separate read/query, structured insert/update/delete and schema-management MCP tools with their input schemas and accurate read-only/destructive metadata. All tools resolve the one configured principal for the chosen logical connection. Tool classification does not grant additional privilege; do not add arbitrary general-SQL execution as part of this simplification.
5. Preserve SQL/read-query guards, structured mutation bounds and transaction safeguards, query timeouts, result limits, failure reporting, non-replay of uncertain mutations and secret-safe observability. These protect operation semantics and availability rather than requiring client approval.
6. **Q3=A:** Remove the separate MCP elicitation confirmation step for destructive DDL, retaining truthful destructive tool annotations. Any end-user confirmation is owned by the MCP client; the Worker must not assume that all clients display a dialog.
7. **Q7=A — One-time breaking configuration migration.** Replace the legacy `read`/`write`/`admin` credential schema with a single, explicitly supplied credential for each logical connection. Once the new parser is deployed, legacy credential keys are invalid with a clear migration error. Do **not** support dual schemas, silently select a legacy credential, or automatically alter database grants. The concrete field names, direct/Hyperdrive shape and migration examples are implementation-spec details still to be decided.
8. Migrate the operator-controlled `DATABASE_CONFIG` outside GitHub, and validate new-format configuration, required bindings, connection health, safe read, structured mutation and supported DDL against test databases before any separately authorized production release. Fail closed when the format or credential is missing. Secret values must never be copied into documentation, code, tests, CI variables or logs.

## Consequences

**Positive:** fewer DSN/secret entries; no separate credential-resolution paths for read, write and schema tasks; more predictable deployment configuration.

**Negative:** the one configured account may now hold powerful permissions; token compromise, prompt injection or an over-authorized client can cause changes formerly blocked by a separate read-only principal. A mistaken destructive operation could affect live data. Client-level confirmation is not guaranteed for every request or across MCP clients.

**Operational:** existing READ/WRITE/ADMIN configurations require deliberate one-time migration; there is no transitional dual-schema parser. Previously separate credential values must not be silently selected or merged. Until the operator updates the Cloudflare secret and authorizes a release, the current production implementation and configuration are unchanged. Deployment, grant changes and secret rotation are separate actions.

## Supersession scope

This decision supersedes the *credential separation* aspect of `apps/database-mcp-worker/docs/safe-admin-v0.3.md` after implementation. It does not retroactively change that document's descriptions of the deployed implementation, nor decide to keep or remove Safe Admin's tool schemas.

## Non-decisions

- No current database user or permission is changed.
- No migration code, production Worker, runtime secret or database schema has been modified. Q7 determines migration behavior; the exact replacement schema and the current direct-only Admin/DDL transport limitation still need detailed specification.
- No decision that one credential implies superuser or administrator access.
- No assumption that all connected MCP clients require user confirmation.
