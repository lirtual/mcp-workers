# ADR-0001 — One database principal per logical connection

Status: **Accepted as an architectural direction; implementation pending**. Date: 2026-10-13. Q2=B, Q4=A, Q7=A, Q10=A, Q13=A and Q19=A confirmed.
**2026-10-14 config-shape refinement:** The owner explicitly approved a *flat, multi-connection* `DATABASE_CONFIG`; the nested `connection` object previously illustrated below is superseded. This is a design-only change; current `main` and production still use the legacy parser.
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
7. **Q7=A — One-time breaking configuration migration.** Replace the legacy `read`/`write`/`admin` credential schema with a single, explicitly supplied credential for each logical connection. Once the new parser is deployed, legacy credential keys are invalid with a clear migration error. Do **not** support dual schemas, silently select a legacy credential, or automatically alter database grants. The flat value shape, direct/Hyperdrive discriminator and migration example are fixed by the later 2026-10-14 clarification below.
8. Migrate the operator-controlled `DATABASE_CONFIG` outside GitHub, and validate new-format configuration, required bindings, connection health, safe read, structured mutation and supported DDL against test databases before any separately authorized production release. Fail closed when the format or credential is missing. Secret values must never be copied into documentation, code, tests, CI variables or logs.
9. **Q10=A:** Preserve the currently verified **direct-only** execution restriction for schema-management tools. A logical connection using Hyperdrive may continue supported read/structured data operations, but requests for unverified DDL must fail with an explicit unsupported-transport result. The one-principal model does not imply transport compatibility; do not fall back silently to a separate direct/admin account or automatically grant DDL privileges.
10. **Q13=A (historical interview choice; representation later refined):** The user first chose a canonical `connection` field per logical ID, sharing one credential across all tool categories. **The later 2026-10-14 owner decision supersedes that nested field and optional per-connection flags:** use the flat ID → SQL URL map, with a strict Hyperdrive reference object only when needed, as specified below. Safe limits still apply globally.
11. Explicitly reject old role-separated connection fields (including old nested `read`, `write` or `admin`) instead of guessing an account from any of them. Missing or invalid canonical connection syntax fails closed with a migration error. Limit disclosure in logs and validation messages to connection IDs and field names, never credentials.
12. **Q19=A — Short, explicit fail-closed maintenance is acceptable.** A separately authorized production migration may briefly refuse Database MCP requests while the Cloudflare `DATABASE_CONFIG` Secret is updated and the new Worker version is activated. No dual parser or zero-downtime choreography is required. Validate schema and credentials safely off production, record old/new version identifiers and a reviewed recovery path, then confirm new-version activation, supported queries and grants. Do not intentionally change the live Secret, publish or interrupt service in this design phase.


## Superseding canonical `DATABASE_CONFIG` representation (approved 2026-10-14)

Retain **multiple named connections**, with one database principal per logical ID. Keep the existing Cloudflare Runtime Secret name `DATABASE_CONFIG`. The only top-level form is a JSON object mapping **connection ID directly to its value**, with **no nested `connection` field**:

```json
{
  "scrape_relay": "mysql://example-reader:REDACTED@db.example.invalid:3306/scrape_relay",
  "analytics": "postgres://example-user:REDACTED@pg.example.invalid:5432/analytics",
  "reporting": {
    "hyperdrive": "REPORTING_HYPERDRIVE",
    "dialect": "postgres"
  }
}
```

A **direct SQL URL string** is the standard case. A strict `{ "hyperdrive": "<binding>", "dialect": "mysql|postgres" }` value is the **only special-case object**, for an existing configured Hyperdrive binding; its fields are not general per-connection options. Validate exact allowed keys and expected value types, and reject nested `connection`, `read`, `write`, `admin`, `enabled`, `displayName`, other unsupported keys and alternate/ambiguous formats. No format sniffing or legacy dual parser. A connection exists iff its ID is in the map; removing it disables it. The map is nonempty and remains bounded to 50 unique valid IDs. A connection's displayed name defaults to its ID.

Preserve `list_connections` so a client can discover IDs. Each existing tool retains its `connection` parameter, but when **exactly one** connection exists, omission resolves to that single ID. With **two or more**, omission must fail with a clear non-secret missing-connection error; never choose a first/last/default connection based on map ordering. Explicit IDs must be validated and unknown IDs must fail closed. Keep explicit `schema` parameters for database/schema selection, as appropriate to the existing tools. Per-connection optional override fields (including `defaultSchema` and bounds) are **not part of this simplified Secret format**; retain safe existing **global/default** query/write limits and existing tool arguments.

All read, structured mutation and supported DDL tools resolve the same database principal selected by ID; real MySQL/PostgreSQL grants determine permitted actions. Direct TLS restriction and **Hyperdrive DDL refusal** remain unchanged. Authentication, SQL validation, parameterization, affected-row rollback, rate limiting, error redaction and non-replay guarantees remain. The code migration must be reviewed and tested before a **separately approved** production Secret update/activation; never paste real credentials into GitHub, logs or tickets.

This newer explicit decision supersedes only Q13's *nested-object configuration representation* and the implied `enabled`/display/per-connection-override exposure; it **does not supersede** the one-principal-per-logical-connection, transport, safeguard or release decisions.

## Consequences

**Positive:** fewer DSN/secret entries; no separate credential-resolution paths for read, write and schema tasks; more predictable deployment configuration.

**Negative:** the one configured account may now hold powerful permissions; token compromise, prompt injection or an over-authorized client can cause changes formerly blocked by a separate read-only principal. A mistaken destructive operation could affect live data. Client-level confirmation is not guaranteed for every request or across MCP clients.

**Operational:** existing READ/WRITE/ADMIN configurations require deliberate one-time migration; there is no transitional dual-schema parser. Previously separate credential values must not be silently selected or merged. A bounded maintenance window is a permitted future strategy, not an instruction to modify the running service. Until the operator updates the Cloudflare secret and authorizes a release, the current production implementation and configuration are unchanged. Deployment, grant changes and secret rotation are separate actions.

## Supersession scope

This decision supersedes the *credential separation* aspect of `apps/database-mcp-worker/docs/safe-admin-v0.3.md` after implementation. It does not retroactively change that document's descriptions of the deployed implementation, nor decide to keep or remove Safe Admin's tool schemas.

## Non-decisions

- No current database user or permission is changed.
- No migration code, production Worker, runtime secret or database schema has been modified. Q7 determines migration behavior; the flat multi-connection format is now selected, while its strict parser/omitted-connection behavior still require contract tests. The direct-only Admin/DDL transport boundary is now a settled Q10 decision.
- No decision that one credential implies superuser or administrator access.
- No assumption that all connected MCP clients require user confirmation.
