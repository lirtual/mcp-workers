# Cloudflare Database MCP v0.1 Technical Specification

**Status:** Ready for implementation
**Target release:** v0.1
**Date:** 2026-09-12
**Scope:** Cloudflare-native, read-only MCP server for MySQL and PostgreSQL through Hyperdrive

## 1. Problem

A ChatGPT/MCP client needs safe, low-friction access to existing MySQL and PostgreSQL databases without exposing database credentials to the client and without relying on an LLM, prompt instructions, or a SQL parser as the primary authorization boundary.

The system must be simple enough for personal use and open-source deployment, while preserving a security model that can later grow to controlled write access without redesigning the read path.

## 2. Solution

Build a standalone Cloudflare Worker named `database-mcp` that exposes a small read-only MCP tool surface. The Worker authenticates the caller as an OAuth resource server, routes requests to statically configured logical database connections, and executes reads through Cloudflare Hyperdrive using dedicated read-only database credentials.

The primary security boundary is layered:

1. MCP tools define which capabilities are exposed.
2. Each logical read connection maps to a read-only Hyperdrive binding.
3. The binding uses a dedicated least-privilege database account.
4. Database-native privileges, views, RLS, and function/routine permissions define which data that account can actually access.

Worker-side SQL inspection may improve ergonomics and reject obviously invalid requests, but it is not an authorization boundary.

## 3. Goals

- Support existing MySQL/MySQL-compatible and PostgreSQL databases through Cloudflare Hyperdrive.
- Work as a remote MCP server for ChatGPT and other compatible MCP clients.
- Keep v0.1 read-only end-to-end.
- Keep database credentials out of MCP requests and responses.
- Default all reads to fresh database state by disabling Hyperdrive query caching.
- Provide schema discovery, read-only SQL querying, query-plan inspection, connection discovery, and health checks.
- Use official or first-party-supported runtime components where practical.
- Fail closed when authentication, connection resolution, input validation, or database authorization is uncertain.
- Remain deployable as a small standalone Worker without D1, Durable Objects, a web admin UI, or a separate application server.
- Preserve a clean evolution path to structured safe-write tools in v0.2.

## 4. Non-Goals for v0.1

The following are explicitly out of scope:

- Raw write SQL.
- `INSERT`, `UPDATE`, `DELETE`, DDL, migrations, user management, or administrative SQL.
- A `safe_write` or `high_risk_write` mode.
- D1 connection registry or runtime connection onboarding.
- D1 principals/RBAC tables.
- Durable Object confirmation state.
- MCP multi-round-trip confirmation flows.
- A web administration UI.
- Full DBX-style database-client functionality.
- Database migrations or schema diffing.
- Long-lived transactions or transaction sessions across MCP calls.
- Stored procedure/routine execution as a supported feature.
- Dynamic credential creation or credential rotation.
- Query-result persistence or application-level result caching.
- Support for databases other than MySQL/MySQL-compatible and PostgreSQL.
- Complete DBA feature parity, including PostgreSQL advisory locks, `LISTEN/NOTIFY`, or other Hyperdrive-incompatible session features.
- Multi-tenant SaaS billing, quotas, organizations, or team administration.

## 5. User Stories

1. As an authenticated database user, I want to list the logical database connections available to me, so that I know which databases I can inspect.
2. As an authenticated database user, I want to inspect schemas, tables, columns, indexes, and foreign keys, so that I can understand a database before writing a query.
3. As an authenticated database user, I want to run a read-only SQL query, so that I can retrieve current data through natural-language-assisted database analysis.
4. As an authenticated database user, I want query parameters to be supported, so that values do not need to be interpolated into SQL text.
5. As an authenticated database user, I want query results to be bounded, so that an accidental unbounded query cannot return an excessive payload.
6. As an authenticated database user, I want long-running queries to be terminated, so that one request cannot consume database or Worker resources indefinitely.
7. As an authenticated database user, I want to inspect a read query's execution plan without executing it with `ANALYZE`, so that I can investigate performance safely.
8. As an authenticated database user, I want to check whether a configured connection is reachable, so that I can distinguish connectivity failures from query failures.
9. As an authenticated database user, I want fresh results by default, so that operational questions are not answered from Hyperdrive query cache.
10. As an authenticated database user, I want errors to be useful but sanitized, so that I can fix a query without receiving secrets or sensitive infrastructure details.
11. As an operator, I want database credentials to remain inside Cloudflare/Hyperdrive configuration, so that MCP clients never receive or provide them.
12. As an operator, I want each logical connection to use a dedicated least-privilege read account, so that a Worker or model mistake cannot become a database write.
13. As an operator, I want connection metadata to be statically declared for v0.1, so that the system has a single source of truth and no configuration drift between D1 and Worker bindings.
14. As an operator, I want structured request logs without full result bodies, so that I can troubleshoot usage without creating a second sensitive data store.
15. As an operator, I want rate limiting per authenticated principal and logical connection, so that abusive or accidental loops are contained.
16. As an operator, I want authentication failures to fail closed, so that no database tool is callable without a valid trusted identity.
17. As an operator, I want disabled or unknown logical connection names to be rejected before a database connection is attempted, so that clients cannot address arbitrary Hyperdrive bindings.
18. As an operator, I want database-native row/column protections to remain authoritative, so that sensitive-data controls do not depend on model behavior or Worker SQL rewriting.
19. As an open-source deployer, I want both MySQL and PostgreSQL adapters behind the same MCP surface, so that client behavior stays consistent across supported dialects.
20. As a maintainer, I want integration tests to run against real MySQL and PostgreSQL instances, so that driver and dialect behavior is verified rather than only mocked.
21. As a maintainer, I want security regression tests for read-only boundaries, so that attempts to write, chain statements, or exploit callable routines do not silently expand capability.
22. As a future maintainer, I want the read path isolated from future write credentials, so that v0.2 can add structured writes without weakening v0.1 guarantees.

## 6. Architecture

### 6.1 Runtime topology

```text
MCP Client / ChatGPT
        |
        | OAuth bearer token + MCP 2026-07-28
        v
Cloudflare Worker: database-mcp
        |
        |-- authentication / scope validation
        |-- MCP tool dispatch
        |-- logical connection resolution
        |-- rate limiting
        |-- input/output bounds
        |-- sanitized error mapping
        |-- structured logs
        |
        v
Cloudflare Hyperdrive (query caching disabled)
        |
        v
Dedicated read-only DB credential
        |
        +-- MySQL / MariaDB-compatible
        +-- PostgreSQL
```

### 6.2 Component boundaries

The Worker is divided into the following logical modules. These are architectural boundaries, not mandatory source-file names.

- **MCP transport**: exposes the Streamable HTTP endpoint and registers tools.
- **Authentication**: verifies bearer tokens issued by the configured trusted identity provider and derives a principal plus scopes.
- **Connection catalog**: maps a public logical connection id to dialect, display metadata, enabled state, and a specific Hyperdrive binding.
- **Schema inspector**: implements dialect-specific metadata discovery.
- **Read query executor**: executes bounded queries through the selected read binding.
- **Explain executor**: produces non-`ANALYZE` query plans through the read binding.
- **Rate limiter**: limits calls using authenticated principal plus logical connection as the principal key.
- **Error mapper**: converts driver/runtime failures into stable public MCP errors and strips secrets/infrastructure details.
- **Observability**: emits structured logs containing metadata only.

No module may expose the raw Hyperdrive credential or database credential through tool output, logs, exceptions, or resource metadata.

## 7. Authentication and Authorization

### 7.1 Resource-server role

`database-mcp` acts as an OAuth-protected resource server. It does not implement a complete authorization server in v0.1.

A deployment may use an existing trusted issuer such as the user's existing Cloudflare gateway/identity layer or another compatible identity provider. The Worker must validate the token before MCP tool dispatch.

### 7.2 Required identity information

A valid request must yield at minimum:

- stable principal identifier;
- token issuer;
- token audience/resource validity as required by the chosen issuer;
- unexpired token state;
- read scope sufficient for database MCP access.

The exact external issuer is deployment configuration, not application business logic.

### 7.3 Authorization model

For v0.1, authorization is intentionally simple:

- authenticated caller + required read scope;
- only statically enabled logical connections are visible/callable;
- all connection execution paths use read credentials only.

Do not introduce a D1 RBAC schema for the single-user/personal-first v0.1 design.

## 8. Connection Configuration

### 8.1 Static catalog

Connections are deployment configuration. Each entry defines at least:

- logical connection id;
- human-readable name;
- dialect (`mysql` or `postgres`);
- Hyperdrive binding identifier;
- enabled/disabled state;
- optional default schema/database metadata;
- optional per-connection query limits no less restrictive than global safety limits.

The MCP client cannot create a connection, submit a connection string, choose an arbitrary Worker binding, or override database credentials.

### 8.2 Hyperdrive

Each configured read connection must point to a Hyperdrive configuration created with a dedicated read-only database account.

Hyperdrive query caching must be disabled for v0.1 database-assistant connections. Cached analytics connections are a possible future explicit opt-in, not the default.

### 8.3 Database accounts

The project must provide deployment documentation/templates for creating least-privilege read identities.

#### PostgreSQL

The recommended account is:

- not a database/schema/table owner;
- not superuser;
- no `BYPASSRLS`;
- granted only necessary `CONNECT`, schema `USAGE`, and table/column `SELECT`;
- subject to RLS where the target database uses RLS;
- not granted unnecessary sequence privileges;
- not permitted to execute unreviewed side-effecting functions/procedures;
- configured with `default_transaction_read_only=on` and a reasonable `statement_timeout` as additional defense.

Deployers must explicitly review `PUBLIC EXECUTE` and security-definer/function privileges relevant to the exposed schemas.

#### MySQL

The recommended account is granted only required `SELECT` access at database/table/column scope.

It must not be granted write/DDL/admin privileges such as `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `ALTER`, `DROP`, `FILE`, `EXECUTE`, `LOCK TABLES`, or `GRANT OPTION` unless a future version explicitly introduces a separate capability path.

Sensitive columns should be protected by column grants or restricted views, not by model instructions.

## 9. MCP Tool Contracts

v0.1 exposes five tools. Tool names are stable for v0.1.

### 9.1 `list_connections`

Purpose: return the logical connections available to this deployment.

Input: none.

Output per connection:

- logical id;
- display name;
- dialect;
- enabled/read-only state;
- optional non-sensitive schema/database hint.

Must not return Hyperdrive ids/binding internals, hosts, ports, usernames, passwords, or connection strings.

Tool annotations should mark the operation read-only and idempotent.

### 9.2 `inspect_schema`

Purpose: return machine-readable metadata needed to formulate safe queries.

Input:

- logical connection id;
- optional schema/database selector;
- optional table selector;
- optional bounded metadata options if needed by implementation.

Output may include:

- schemas/databases visible to the read account;
- tables/views;
- columns and types;
- nullability/default metadata where non-sensitive;
- primary keys;
- foreign keys;
- indexes.

The output must be bounded by configured metadata/result size limits.

Do not return stored procedure/function source code or other executable body text in v0.1.

### 9.3 `query_read`

Purpose: execute a single read query against one logical connection.

Input:

- logical connection id;
- SQL text;
- optional parameter array/map as supported by the dialect adapter;
- optional requested row limit not exceeding the server maximum.

Contract:

- exactly one SQL statement is accepted;
- execution always uses the connection's READ Hyperdrive binding;
- no write/admin credential exists in this tool's code path;
- database-native privileges are the final authorization gate;
- server enforces row, payload-size, and execution-time limits;
- no query result is persisted by the MCP service;
- the client cannot enable Hyperdrive query caching;
- dialect/driver errors are sanitized.

Worker-side validation should reject clearly unsupported statements and obvious multi-statement input before execution, but safety must not depend on perfectly classifying arbitrary SQL.

Parameter values must be sent using the database driver's parameter mechanism supported through Hyperdrive rather than manually interpolated into SQL text.

### 9.4 `explain`

Purpose: inspect the planner output for a read query without executing it in an analysis mode that mutates data.

Input:

- logical connection id;
- read SQL;
- parameters if supported.

Contract:

- only plain explain/planner behavior is allowed;
- `EXPLAIN ANALYZE` or equivalent execution modes are rejected;
- the underlying credential remains READ-only;
- output is bounded.

### 9.5 `health_check`

Purpose: verify the configured logical read path.

Input:

- logical connection id.

Output:

- success/failure;
- dialect;
- high-level latency/health metadata;
- sanitized failure category.

Must not expose host, password, connection string, or private network topology.

## 10. Result and Resource Limits

Default v0.1 limits:

- query rows: 500;
- query serialized result size: 1 MiB;
- query execution timeout: 15 seconds;
- schema inspection serialized output: 512 KiB.

These are deployment defaults and may be made stricter per connection.

The implementation must not silently return unlimited data. If a query exceeds a row or output-size limit, the response must either:

- return a clearly marked truncated result, or
- fail with a stable public limit error.

The chosen behavior must be consistent and covered by tests.

The server should not retain a large server-side result set solely to implement pagination in v0.1. The caller may issue a subsequent bounded query.

## 11. Query Semantics and Guardrails

### 11.1 Security responsibility

SQL classification is not an authorization mechanism. The READ credential is authoritative.

A lightweight dialect-aware validator/parser may be used for:

- rejecting multiple statements;
- refusing explicit DML/DDL with a clearer error before database execution;
- preventing `EXPLAIN ANALYZE`;
- validating tool-specific statement shape;
- applying or validating safe row limits where practical.

A parsing failure or unknown shape must fail closed at the Worker before execution unless it is a supported query path already constrained by an independently verified read-only database account and the spec explicitly allows that shape.

### 11.2 Side-effecting routines

`query_read` is not intended as a stored-procedure/routine execution interface.

PostgreSQL deployments must harden function/procedure execution at the database privilege layer. MySQL deployments must not grant `EXECUTE` to the read account unless a reviewed future feature explicitly requires it.

### 11.3 Multi-statement execution

Do not support multi-statement SQL in v0.1.

## 12. Driver and Runtime Decisions

- Language: TypeScript.
- Runtime: Cloudflare Workers with Node.js compatibility enabled where required by the selected drivers.
- MCP: current official Model Context Protocol TypeScript SDK compatible with the 2026-07-28 protocol and Cloudflare Workers Web-standard request/response handling.
- PostgreSQL driver: `pg` / node-postgres, validated against current Hyperdrive documentation at implementation time.
- MySQL driver: `mysql2 >= 3.13.0`, using Hyperdrive-supported query execution paths and `disableEval: true` where required/recommended by current Cloudflare guidance.
- Input validation: Zod or the validation mechanism already required by the current official MCP SDK.
- Target database ORM: none.
- Hono: not required in v0.1. Introduce only if routing/API complexity demonstrates a need.
- D1: not used in v0.1.
- Durable Objects: not used in v0.1.

Implementation must verify exact package/API versions against current first-party documentation before locking dependencies.

MySQL implementation must not require MySQL protocol-level prepared statements or multi-statements.

## 13. Error Model

Public tool failures must map to a stable error taxonomy. At minimum:

- `AUTH_REQUIRED`
- `AUTH_INVALID`
- `ACCESS_DENIED`
- `CONNECTION_NOT_FOUND`
- `CONNECTION_DISABLED`
- `CONNECTION_UNAVAILABLE`
- `INVALID_INPUT`
- `MULTI_STATEMENT_REJECTED`
- `READ_ONLY_VIOLATION`
- `QUERY_TIMEOUT`
- `RESULT_LIMIT_EXCEEDED` or explicit truncation metadata where partial results are valid
- `DATABASE_ERROR`
- `INTERNAL_ERROR`

Public error responses must not expose:

- passwords or connection strings;
- bearer tokens;
- private Worker binding names;
- private network addresses unless explicitly classified as non-sensitive deployment metadata;
- database-driver internals that materially increase attack value.

Fuller diagnostics may be emitted to protected operator logs, subject to the logging rules below.

## 14. Observability and Audit

v0.1 uses structured Cloudflare/Workers logging and does not introduce D1 solely for audit persistence.

Each tool invocation should emit structured metadata including where available:

- request/correlation id;
- principal id or stable pseudonymous identifier;
- tool name;
- logical connection id;
- dialect;
- duration;
- success/failure;
- returned row count or metadata count;
- truncation state;
- stable public error code.

For `query_read` and `explain`, logs should store at most a hash plus a bounded sanitized preview of SQL, or hash-only for stricter deployments. Full result rows must not be logged.

Bearer tokens, passwords, complete connection strings, and returned business data must never be intentionally logged.

## 15. Rate Limiting

Rate limiting is required as an abuse-control mechanism.

- Key on authenticated principal plus logical connection where practical.
- Apply deployment-wide and/or per-connection thresholds.
- Treat Cloudflare rate limiting as approximate abuse control, not as an authorization boundary, billing meter, or exact quota system.
- Rate-limit failures must be explicit and must not fall back to unrestricted execution.

## 16. Security Invariants

The following are non-negotiable acceptance conditions:

1. No v0.1 MCP tool can intentionally select a WRITE or ADMIN database credential.
2. The application never accepts a database connection string or database password from an MCP caller.
3. An unauthenticated request cannot invoke any database tool.
4. An unknown logical connection id cannot address arbitrary environment bindings.
5. Hyperdrive query caching is disabled for v0.1 connections.
6. Database-native least privilege is required even if Worker-side query validation exists.
7. SQL parsing or keyword checks are never treated as the sole reason a request is safe.
8. PostgreSQL routine execution privileges are explicitly audited for the read role.
9. Tool output and logs never expose secrets.
10. There is no raw write SQL path in v0.1.
11. `explain` never enables `ANALYZE` or an equivalent execution mode.
12. Query results are bounded by rows, size, and time.
13. The server fails closed on authentication and connection-resolution uncertainty.

## 17. Testing Strategy

Testing must prefer the highest practical external seam: invoking MCP tools against a deployed/test Worker path connected to real disposable MySQL and PostgreSQL databases.

### 17.1 Unit tests

Unit tests may cover pure components such as:

- connection catalog resolution;
- public error sanitization;
- request validation;
- limit clamping;
- safe log-field construction.

Avoid mock-heavy tests of internal layering where integration tests provide stronger evidence.

### 17.2 Integration tests

CI or a dedicated integration environment must run against disposable real MySQL and PostgreSQL instances.

Required cases include:

- list connections;
- inspect schema;
- parameterized read query;
- row truncation;
- timeout behavior;
- plain explain;
- `EXPLAIN ANALYZE` rejection;
- invalid/disabled connection;
- connection failure;
- sanitized database error;
- successful health check.

### 17.3 Security regression tests

The suite must demonstrate that the read path remains read-only even when requests attempt:

- `INSERT`, `UPDATE`, `DELETE`, and DDL;
- multiple statements;
- comments or formatting intended to confuse superficial classification;
- PostgreSQL side-effecting functions/routines available in the fixture database;
- sequence mutation attempts where relevant;
- MySQL stored routine execution;
- access to columns/tables denied by database-native privileges;
- access to rows hidden by PostgreSQL RLS where a fixture uses RLS;
- tool calls without authentication;
- tool calls using an unknown connection id.

A security regression is considered failed if a forbidden database-side state change succeeds, even if the Worker attempted to classify the SQL as read-only.

### 17.4 Cloudflare staging verification

Before release, run a staging deployment using actual Hyperdrive bindings to verify:

- current Workers runtime compatibility;
- `pg` compatibility;
- `mysql2` compatibility;
- disabled Hyperdrive query caching;
- OAuth resource-server integration;
- MCP transport behavior with the target ChatGPT client;
- rate-limit binding behavior;
- payload and timeout behavior under realistic limits.

## 18. Suggested Repository Boundaries

Keep v0.1 as one package/repository rather than a monorepo.

Recommended conceptual areas:

- MCP transport and tool registration;
- authentication;
- connection catalog;
- MySQL adapter;
- PostgreSQL adapter;
- query execution and limits;
- schema inspection;
- error mapping;
- observability/rate limiting;
- integration fixtures and tests.

Do not introduce an ORM for target databases. D1 is not used in v0.1.

## 19. Release Acceptance Criteria

v0.1 is releasable only when all of the following are true:

1. A ChatGPT/MCP client can authenticate and discover the five defined tools.
2. Both MySQL and PostgreSQL can be configured through Hyperdrive and queried successfully.
3. `list_connections`, `inspect_schema`, `query_read`, `explain`, and `health_check` behave according to this specification.
4. Hyperdrive query caching is disabled and verified in staging.
5. MySQL and PostgreSQL integrations use dedicated read-only database accounts.
6. Forbidden write/DDL attempts fail at the database boundary in security tests.
7. PostgreSQL routine/function privilege hardening is represented in deployment documentation and security fixtures.
8. Result row, payload, and time bounds are enforced.
9. Error responses are sanitized.
10. Logs contain sufficient troubleshooting metadata without secrets or full result bodies.
11. Authentication and rate limiting are active in staging.
12. Integration and security regression test suites pass for both supported dialects.
13. No D1, Durable Object, Hono, raw write SQL, admin endpoint, or web UI is required to operate v0.1.

## 20. Deferred Roadmap

### v0.2 — Structured safe write

Only after v0.1 is stable:

- add a separate WRITE Hyperdrive binding and limited-write DB role for connections that opt in;
- add structured tools such as `insert_rows`, `update_rows`, and `delete_rows`;
- keep `query_read` permanently bound to READ credentials;
- use MCP 2026-07-28 multi-round-trip `input_required` for sensitive update/delete confirmation;
- add durable audit/idempotency storage only if the write guarantees require it;
- do not add raw write SQL by default.

### v0.3 — Optional admin plane

Only if there is a demonstrated need:

- use a separate ADMIN credential;
- preferably expose admin/DDL through a separate MCP endpoint or application;
- reassess whether Hyperdrive remains the correct transport for DBA/session-heavy capabilities;
- evaluate D1 control-plane metadata, dynamic onboarding, and richer RBAC only at that stage.

## 21. Reference Constraints

Implementation must re-check current first-party documentation at coding time because MCP and Cloudflare evolve quickly. The architectural decisions in this spec were validated against the following primary sources during design:

- MCP 2026-07-28 tool and transport specification: https://github.com/modelcontextprotocol/modelcontextprotocol/tree/main/docs/specification/2026-07-28
- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- Cloudflare Hyperdrive: https://developers.cloudflare.com/hyperdrive/
- Cloudflare Hyperdrive supported databases/features: https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/
- Cloudflare Hyperdrive MySQL example: https://developers.cloudflare.com/hyperdrive/examples/connect-to-mysql/
- Cloudflare Hyperdrive PostgreSQL example: https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/
- Cloudflare Workers Rate Limiting API: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- PostgreSQL privileges and RLS: https://www.postgresql.org/docs/current/sql-grant.html and https://www.postgresql.org/docs/current/ddl-rowsecurity.html
- PostgreSQL function/security behavior: https://www.postgresql.org/docs/current/ddl-priv.html and https://www.postgresql.org/docs/18/sql-createfunction.html
- MySQL privileges and views: https://dev.mysql.com/doc/refman/8.4/en/privileges-provided.html and https://dev.mysql.com/doc/refman/8.4/en/create-view.html

## 22. Final Architectural Principle

> The LLM decides what it wants to do; the MCP tool surface decides what capability is exposed; the selected Hyperdrive credential decides the maximum privilege of that execution path; and database-native privileges decide what data is actually accessible.

No Worker-side SQL parser, prompt instruction, or client annotation is a substitute for database-native least privilege.
