# Cloudflare Database MCP 架构深度审查

日期：2026-09-12

## 结论

原方案长期方向正确，但作为 v0.1 并非最佳：D1 Connection Registry、Principal/ACL、Durable Object confirmation、SQL AST 作为安全边界、Hono、同一 raw query 工具承担读写能力等存在不同程度的过度设计或安全复杂化。

更优的架构是：**MCP 工具边界 + 独立数据库凭证/Hyperdrive binding + 数据库原生权限**作为主要安全边界；Worker 只做 OAuth、工具路由、输入验证、速率限制、结果限制、错误净化和审计。

## 一手资料核验

### MCP 2026-07-28

- Streamable HTTP 已改为单 POST endpoint、无协议级 session；适合无状态 Worker。
  - https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/transports/streamable-http.mdx
- 2026-07-28 提供 Multi-Round-Trip Requests / `input_required`，明确适用于中途向用户索取确认或缺失输入；因此自建 `confirm_operation` + Durable Object 并非首选。
  - https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/server/tools.mdx
  - https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/blog/content/posts/2026-07-28-spec-ga/index.md
- MCP tool annotations（readOnly/destructive/idempotent）只是 hints，不能当授权机制。
  - https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/server/tools.mdx
- 官方 TypeScript SDK v2 已原生支持 Web-standard `Request`/`Response` 和 `createMcpHandler`，Hono 只是可选薄适配层。
  - https://github.com/modelcontextprotocol/typescript-sdk
  - https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/authorization.md

### Cloudflare Hyperdrive

- Hyperdrive 支持 PostgreSQL、MySQL/MySQL-compatible；MySQL 推荐 `mysql2 >= 3.13.0`，PostgreSQL 官方推荐 `pg`，Postgres.js 也支持。
  - https://developers.cloudflare.com/hyperdrive/examples/connect-to-mysql/
  - https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/
- Hyperdrive binding 是 Worker 部署配置；D1 Registry 并不能让任意新数据库在运行时自动出现为新 binding。
  - https://developers.cloudflare.com/hyperdrive/get-started/
- Hyperdrive query cache 默认开启；对于数据库管理/查询助手，freshness 通常比缓存更重要，官方支持 `--caching-disabled`。
  - https://developers.cloudflare.com/hyperdrive/concepts/query-caching/
- MySQL 经 Hyperdrive 不支持 multi-statement，也不支持 protocol-level prepared statements；示例使用 `mysql2.connection.query()`。
  - https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/
  - https://developers.cloudflare.com/hyperdrive/examples/connect-to-mysql/
- PostgreSQL Hyperdrive 不支持 advisory locks、LISTEN/NOTIFY 和部分 session state；因此 Hyperdrive 很适合查询/常规 DML，不应该承诺完整 DBA 代理能力。
  - https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/
- Workers Rate Limiting binding 可用于 user/resource key 的滥用控制，但它是 local + eventually consistent，不应作为精确计费或严格授权边界。
  - https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/

### 数据库原生权限

- PostgreSQL 支持 table/column GRANT、Row-Level Security；数据库权限应作为核心数据访问边界。
  - https://www.postgresql.org/docs/current/sql-grant.html
  - https://www.postgresql.org/docs/17/ddl-rowsecurity.html
- PostgreSQL 默认对 PUBLIC 赋予函数/过程 EXECUTE；安全的 MCP read role 需要特别审计/revoke 可产生副作用的函数权限。`READ ONLY` transaction 禁止主要 DML/DDL，但属于“high-level read-only”，不是绝对无副作用。
  - https://www.postgresql.org/docs/current/ddl-priv.html
  - https://www.postgresql.org/docs/18/sql-set-transaction.html
  - https://www.postgresql.org/docs/18/sql-createfunction.html
- MySQL 支持 database/table/column privilege；stored routines 需要 EXECUTE，views 可通过 SQL SECURITY 控制上下文。最小权限账号比 Worker SQL 解析更可靠。
  - https://dev.mysql.com/doc/refman/8.4/en/privileges-provided.html
  - https://dev.mysql.com/doc/refman/8.4/en/create-view.html
  - https://dev.mysql.com/doc/refman/8.4/en/stored-objects-security.html

## 原方案需要调整的地方

### 1. SQL AST 不应成为安全边界

任意 SQL 的“只读/安全写/危险写”判定并不可靠。`SELECT` 可调用函数；字段 denylist 也可能通过表达式、聚合、谓词、错误侧信道或 security-definer function 间接泄露。

建议：

- raw `query` 永远使用专用 **READ credential**。
- safe write 使用另一套 **WRITE credential**，并通过结构化 MCP tools 暴露。
- DDL/admin 如未来需要，再使用第三套 **ADMIN credential**，默认不暴露给 ChatGPT。
- AST parser 最多用于 UX/resource guard（单语句、LIMIT、方言错误提示），而不是授权。

### 2. 读写工具必须分离

不要让一个 `query(sql)` 有时读、有时写。这样 MCP tool annotation 不准确，也扩大 prompt injection 的影响面。

建议：

- `query_read`：只走 READ binding，`readOnlyHint=true`。
- 后续 `insert_rows` / `update_rows` / `delete_rows`：只走 WRITE binding。
- raw write SQL 默认不存在。

### 3. D1 Registry 暂缓

Hyperdrive binding 本身是部署期配置，因此 D1 中保存 binding name 并不会真正实现动态连接。它反而制造两份配置源和漂移问题。

v0.1 推荐静态连接清单（wrangler + TypeScript config），等有 Web 管理后台/动态 onboarding 需求再引入 D1 control plane。

### 4. Durable Object confirmation 删除

MCP 2026-07-28 的 MRTR / `input_required` 就是为“工具执行过程中需要用户确认”设计的。

- 普通确认：使用 MRTR + signed/sealed requestState。
- 如果未来要求 exactly-once destructive operation，再增加 D1 operation ledger / idempotency key；不需要为了确认本身引入 Durable Object。

### 5. Hono 不是默认依赖

官方 MCP SDK v2 已支持 Web-standard Worker handler。v0.1 endpoint 很少时直接使用 `createMcpHandler` + auth gate 更小。

只有未来增加 admin API、复杂 routing、Pages UI 等再引入 Hono。

### 6. Hyperdrive cache 默认关闭

数据库助手通常需要“当前真实状态”。Hyperdrive cache 默认开启，因此应显式 `--caching-disabled`。

未来 analytics connection 可以另外建立 cache-enabled Hyperdrive binding；缓存是 opt-in，不是默认。

### 7. PostgreSQL driver 选择修正

Cloudflare 当前官方推荐 `pg`；之前优先 Postgres.js 并不是最佳默认。建议：

- PostgreSQL：`pg`
- MySQL：`mysql2 >= 3.13.0`，使用 `query()` 路径，不依赖 protocol prepared statements。

## 推荐的最终分阶段架构

### v0.1 — Read-only MCP（最佳起点）

```text
ChatGPT
   ↓ OAuth / MCP 2026-07-28
Cloudflare Worker
   ├─ official MCP TS SDK
   ├─ OAuth resource-server verification
   ├─ Origin validation
   ├─ input/output validation
   ├─ rate limiting
   ├─ result/timeout guards
   ├─ sanitized errors
   └─ structured Workers Logs
        ↓
Hyperdrive (cache disabled)
        ↓
READ-ONLY DB credential
        ↓
MySQL / PostgreSQL
```

不需要：D1、Durable Object、Hono、复杂 RBAC、write confirmation、admin SQL、SQL policy engine。

推荐 tools：

- `list_connections`
- `inspect_schema`
- `query_read`
- `explain`
- `health_check`

### v0.2 — Safe write

每个可写 logical connection 再增加独立 WRITE Hyperdrive binding / DB role。

```text
query_read  -> READ binding
insert_rows -> WRITE binding
update_rows -> WRITE binding
 delete_rows -> WRITE binding
```

- 使用 MCP tool annotations 准确描述 read/write/destructive。
- update/delete 使用 MRTR confirmation。
- 加 D1 audit / operation ledger（若需要 durable audit / idempotency）。
- raw write SQL 仍不开放。

### v0.3 — Admin（可选）

- 独立 ADMIN credential，最好独立 endpoint/app。
- DDL/raw write 不是普通 database-mcp 默认能力。
- 若需要 DBX 式完整 DBA 能力，需要重新评估 Hyperdrive 的 session/feature 限制；此时 DBX/直连方案可能更合适。

## 数据库 hardening

### PostgreSQL read role

至少应做到：

- 非 owner / 非 superuser / 无 BYPASSRLS。
- 仅必要 schema USAGE + table/column SELECT。
- 使用 RLS / restricted views 做行列级边界。
- 审计并 revoke 不需要的 function/procedure EXECUTE，尤其 SECURITY DEFINER / VOLATILE routines。
- 不授予写 sequence 所需权限；注意 `nextval` 等 sequence 操作。
- 设置 `default_transaction_read_only=on` 与合理 `statement_timeout`，作为额外防线。

### MySQL read account

至少应做到：

- 仅所需 database/table/column SELECT。
- 不授予 INSERT/UPDATE/DELETE/CREATE/ALTER/DROP/FILE/EXECUTE 等。
- 如需隐藏字段，使用 column grants 或 restricted views。
- 对 SELECT 使用合理执行时间限制。

## OAuth 设计

`database-mcp` 最适合充当 OAuth Resource Server，而不是自己同时承担完整 Authorization Server。

- 直接模式：指向 Cloudflare Access / Cloudflare OAuth Provider / 其他 IdP。
- Gateway 模式：由现有 `cloudflare_gateway` 统一身份入口，再让 database-mcp 验证受信任 token。
- MCP 官方 TypeScript SDK 已将 authorization-server helpers 视为 legacy，新服务更适合专用 identity provider。

## 最终原则

> LLM 决定“想做什么”；MCP tool 决定“暴露什么能力”；独立 Hyperdrive credential 决定“这条路径最多能做什么”；数据库原生 GRANT/RLS/View 决定“数据本身允许看到/修改什么”。

Worker SQL parser 不承担最终安全责任。
