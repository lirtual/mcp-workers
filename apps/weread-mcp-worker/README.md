# WeRead MCP

一个面向 Cloudflare Workers 的微信读书 Remote MCP：只读、无状态、零用户数据持久化，唯一上游是腾讯官方 WeChatReading Agent API Gateway。

## 能力

暴露 10 个领域级 MCP tools：

- `weread_search`
- `weread_get_bookshelf`
- `weread_get_book`
- `weread_get_notebooks`
- `weread_get_book_notes`
- `weread_get_popular_highlights`
- `weread_get_highlight_thoughts`
- `weread_get_reading_stats`
- `weread_get_public_reviews`
- `weread_get_recommendations`

设计上不提供任意 upstream API proxy，也不提供 Cookie / 网页抓取 fallback。

## 当前架构

```text
ChatGPT / MCP client
   │
   ▼
Cloudflare MCP Portal
   │ Authorization: Bearer <MCP_ACCESS_TOKEN>
   ▼
WeRead MCP Worker /mcp
   │ Bearer WEREAD_API_KEY
   ▼
Tencent WeRead Agent API Gateway
```

两个 credential 必须完全独立：

- `MCP_ACCESS_TOKEN`：只用于 Portal → WeRead Worker 的入口鉴权。
- `WEREAD_API_KEY`：只用于 WeRead Worker → 腾讯官方 API。

Worker 通过共享 `@mcp-workers/portal-auth` 校验入口 Token；校验成功后会移除真实 `Authorization` header，再把请求交给 MCP SDK。没有 `Origin` header 的服务到服务请求允许继续；WeRead 没有浏览器直连需求，因此出现 `Origin` 时默认拒绝。

## 前置条件

- Node.js 24
- pnpm 10.17.1
- Cloudflare account / Wrangler
- Cloudflare MCP Portal
- 微信读书官方 API Key（`wrk-...`）

## 安装

从 monorepo 根目录执行：

```bash
pnpm install --frozen-lockfile
```

配置 Worker secrets：

```bash
pnpm --filter weread-mcp-worker exec wrangler secret put WEREAD_API_KEY
pnpm --filter weread-mcp-worker exec wrangler secret put MCP_ACCESS_TOKEN
```

不要把任何真实 token 写入仓库，也不要复用 `WEREAD_API_KEY` 作为 Portal 入口凭证。

## 本地开发

本地调试可以临时在 `.dev.vars` 中配置：

```text
WEREAD_API_KEY=wrk-xxxxxxxx
MCP_ACCESS_TOKEN=<high-entropy-random-value>
```

然后：

```bash
pnpm --filter weread-mcp-worker dev
```

MCP route 为 `/mcp`。

## 校验

```bash
pnpm --filter weread-mcp-worker check
pnpm --filter weread-mcp-worker test:mcp
```

包括 TypeScript typecheck、核心协议测试、ESLint、Portal 鉴权边界测试和 Wrangler dry-run。

## Portal 配置

MCP Portal 的 upstream URL 指向该 Worker 实际生产入口的 `/mcp`。Upstream authentication 使用 Bearer，值与 Worker secret `MCP_ACCESS_TOKEN` 一致。ChatGPT / MCP Client 使用 Portal 暴露的地址，而不是绕过 Portal 直接作为普通客户端访问 Worker。

WeRead Worker 不再维护旧 `MCP_ORIGIN_TOKEN`、Gateway/Service Binding 入口兼容或 Worker-owned OAuth。入口认证只保留 `MCP_ACCESS_TOKEN`；微信读书业务授权仍由 `WEREAD_API_KEY` 独立负责。

## Portal 验收顺序

1. `/mcp` 缺失或使用错误 bearer 时返回 401。
2. Worker 未配置 `MCP_ACCESS_TOKEN` 时返回 503。
3. 带非允许 `Origin` 的请求返回 403；无 `Origin` 的 Portal 服务请求可以继续。
4. Portal 能 discover server 并列出原有 10 个 tools。
5. 通过 Portal 调用一个明确指定的只读工具，并确认腾讯上游结果正常。
6. 确认 `MCP_ACCESS_TOKEN`、客户端到 Portal 的凭证、`WEREAD_API_KEY` 均未出现在日志或响应中。

## 协议约束

- 官方 Skill baseline：`1.0.4`
- 上游：`POST https://i.weread.qq.com/api/agent/gateway`
- 每次请求都带 `skill_version`
- 业务参数与 `api_name` / `skill_version` 平铺同级
- `upgrade_info` 出现时立即 fail closed
- 不自动无界拉取所有分页
- 各接口保留自己的 continuation 语义，不虚构万能 cursor

## 隐私

本项目没有 D1、KV、R2、Durable Objects、Queues 或 Cron。Portal 入口不会新增用户数据持久化。
