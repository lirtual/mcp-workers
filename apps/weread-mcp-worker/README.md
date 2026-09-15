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

## 迁移期架构

当前处于 MCP Portal expand 阶段：Portal 路径与原 Gateway + Service Binding 路径并存，待 Portal 真实验收完成后再执行 contract ticket 移除旧入口。

```text
ChatGPT / MCP client
   │
   ▼
Cloudflare MCP Portal + Managed OAuth / Access
   │ Authorization: Bearer <MCP_ORIGIN_TOKEN>
   ▼
WeRead MCP Worker /mcp
   │ Bearer WEREAD_API_KEY
   ▼
Tencent WeRead Agent API Gateway
```

迁移期间原 Gateway 仍可通过 Service Binding 调用同一个 Worker，但也必须注入同一个独立 origin bearer。这样 Worker 即使增加 Portal 可达的 HTTPS custom hostname，也不会出现绕过认证的公开 `/mcp`。

两个 credential 必须完全独立：

- `MCP_ORIGIN_TOKEN`：只用于 Portal/Gateway → WeRead Worker。
- `WEREAD_API_KEY`：只用于 WeRead Worker → 腾讯官方 API。

Worker 在 origin auth 成功后会移除 `Authorization` header，再把请求交给 MCP SDK。

## 前置条件

- Node.js 22+
- Cloudflare account / Wrangler
- Cloudflare MCP Portal / Zero Trust
- 微信读书官方 API Key（`wrk-...`）

## 安装

```bash
npm install
```

配置 secrets：

```bash
npx wrangler secret put WEREAD_API_KEY
npx wrangler secret put MCP_ORIGIN_TOKEN
```

不要把任何真实 token 写入仓库，也不要复用 `WEREAD_API_KEY` 作为 origin credential。

## 本地开发

本地调试可以临时在 `.dev.vars` 中配置：

```text
WEREAD_API_KEY=wrk-xxxxxxxx
MCP_ORIGIN_TOKEN=<high-entropy-random-value>
```

然后：

```bash
npm run dev
```

MCP route 为 `/mcp`。

## 校验

```bash
npm run check
npm run test:mcp
```

包括 TypeScript typecheck、核心协议测试、ESLint 和 MCP/origin-auth 冒烟测试。

## Portal expand 部署

`wrangler.jsonc` 保持：

- `workers_dev = false`
- `preview_urls = false`

为 Worker 配置一个仅用于生产的 HTTPS custom hostname，供 Cloudflare MCP Portal 访问 `/mcp`。不要重新启用 `workers.dev` 作为生产入口。

在 MCP Portal 中添加完整 upstream URL，例如：

```text
https://<weread-worker-custom-domain>/mcp
```

upstream authentication 配置为 Bearer，并使用与 Worker secret `MCP_ORIGIN_TOKEN` 相同的值。ChatGPT / MCP Client 配置 **Portal URL**，不是 raw Worker URL。

### 保留旧 Gateway / Service Binding

Expand 阶段旧 Gateway 仍可保留，但在调用：

```text
env.WEREAD_MCP.fetch(request)
```

之前必须设置：

```text
Authorization: Bearer <MCP_ORIGIN_TOKEN>
```

因此 Service Binding 仍然可回滚使用，同时所有进入 `/mcp` 的路径具有相同的 origin-auth 边界。

## Portal 验收顺序

1. direct `/mcp` 无 bearer 时返回未授权。
2. direct `/mcp` 使用正确 `MCP_ORIGIN_TOKEN` 可到达 MCP transport。
3. Portal 能 discover server 并列出原有 10 个 tools。
4. 通过 Portal 调用一个只读工具并取得正常腾讯上游结果。
5. 确认 `MCP_ORIGIN_TOKEN`、客户端 OAuth token、`WEREAD_API_KEY` 均未出现在日志/响应中。
6. 上述验收完成后，才执行 contract ticket 移除 Gateway / Service Binding 生产依赖。

## 协议约束

- 官方 Skill baseline：`1.0.4`
- 上游：`POST https://i.weread.qq.com/api/agent/gateway`
- 每次请求都带 `skill_version`
- 业务参数与 `api_name` / `skill_version` 平铺同级
- `upgrade_info` 出现时立即 fail closed
- 不自动无界拉取所有分页
- 各接口保留自己的 continuation 语义，不虚构万能 cursor

## 隐私

本项目没有 D1、KV、R2、Durable Objects、Queues 或 Cron。Portal 迁移不会新增用户数据持久化。
