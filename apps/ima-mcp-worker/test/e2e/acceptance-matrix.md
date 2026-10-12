# IMA MCP 验收与契约验证矩阵 (Acceptance Matrix)

本矩阵记录针对前期迁移设计交接及两轮代码审查所识别缺陷的整改与验证结果。自动化测试与真实环境验收分开记账，未运行的在线验证不得视为通过。

## 1. 缺陷整改与双层验证状态表

| 序号 | 问题分类 | 缺陷描述 | 涉及模块 / 文件 | 自动化契约测试 | 真实环境 E2E | 状态说明 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **1** | **Spec (P0)** | `import_urls.results` 误判、空结果或缺项导致假成功 | `src/ima.ts`<br>`src/types.ts` | `test/contract/result-gates.test.ts` | PENDING_AUTH | **契约 PASS**：校验 Map 契约、逐 URL 完整性、结果字段、部分失败与全失败 |
| **2** | **Standards (高)** | 媒体读取及原始元数据暴露临时 headers | `src/ima.ts`<br>`src/tools.ts` | `test/contract/knowledge-read.test.ts` | PENDING_AUTH | **契约 PASS**：headers 仅供服务端拉取；`read_knowledge_source` 和 `get_knowledge_media_info` 均不返回鉴权头 |
| **3** | **Standards (高)** | Worker 无界缓冲远程文件或 IMA 响应 | `src/stream.ts`<br>`src/ima.ts` | `test/contract/knowledge-read.test.ts`<br>`test/contract/upload-flow.test.ts`<br>`test/contract/result-gates.test.ts` | PENDING_AUTH | **契约 PASS**：文本、JSON、二进制与无 Content-Length 上传均有独立上限；溢出取消流 |
| **4** | **Standards (中)** | 验收文档将未发生的真实验收标记为 PASS | `test/e2e/acceptance-matrix.md` | 本文档规范 | **已更正** | **文档 PASS**：诚实拆分“契约模拟测试 PASS”与“真实账户验证 PENDING_AUTH” |
| **5** | **Standards (低)** | 扩展名定义重复维护 | `src/url.ts`<br>`src/preflight.ts` | `test/contract/url-classification.test.ts` | N/A | **契约 PASS**：共享导出 `SUPPORTED_FILE_EXTENSIONS` 单一事实来源 |
| **6** | **Standards (低)** | 生产代码中的 `any` 覆盖类型检查 | `src/` | `npm run typecheck`<br>`rg -n "\\bany\\b" src` | N/A | **构建 PASS**：生产源码无 `any`，`tsc --noEmit` 通过 |
| **7** | **Standards (低)** | 魔法数字散落各处 (`media_type: 1/2/11`) | `src/types.ts`<br>`src/ima.ts` | 单元测试全套 | N/A | **契约 PASS**：定义 `MediaType` 常量，全量重构替换数字硬编码 |
| **8** | **Spec (中)** | 缺少批量文件上传能力 (`uploadBatch`) | `src/ima.ts`<br>`src/tools.ts` | `test/contract/upload-flow.test.ts` | PENDING_AUTH | **契约 PASS**：支持 1-10 个文件批量上传、逐项预检与结构化汇总，向后兼容单文件参数 |
| **9** | **Spec (中)** | 缺少特定业务错误码保留 (`210008`/`210009` 等) | `src/types.ts`<br>`src/ima.ts`<br>`src/tools.ts` | `test/contract/result-gates.test.ts` | PENDING_AUTH | **契约 PASS**：`ImaApiError` 显式保留 `code` 与 `details`，MCP 工具层透出结构化错误 |
| **10** | **Spec (中)** | 缺少 `media_id` 显式校验 | `src/ima.ts` | `test/contract/upload-flow.test.ts`<br>`test/contract/result-gates.test.ts` | PENDING_AUTH | **契约 PASS**：`addNote`、`upload`、`create_media` 对 `media_id` 空值显式抛错拦截 |
| **11** | **Spec (中)** | 缺少 COS 凭据时间戳顺序校验 | `src/ima.ts` | `test/contract/upload-flow.test.ts` | PENDING_AUTH | **契约 PASS**：严格校验整数时间戳及 `expired_time > start_time` |
| **12** | **Spec (低)** | `McpServer` 未注入运行时伴随 instructions | `src/index.ts`<br>`src/instructions.ts` | 启动配置与代码集成 | PENDING_AUTH | **集成 PASS**：`new McpServer` 注入伴随策略 instructions，指导 Agent 意图判断与重试 |
| **13** | **Spec (低)** | 缺少扩展名时的 URL 探针判型 | `src/url.ts` | `test/contract/url-classification.test.ts` | PENDING_AUTH | **契约 PASS**：实现 HEAD 探针，根据 `Content-Type` 与 `Content-Disposition` 识别可下载文件 |
| **14** | **Standards (高)** | 自动重定向可绕过 SSRF 分类 | `src/url.ts`<br>`src/ima.ts` | URL 与媒体读取契约测试 | PENDING_AUTH | **契约 PASS**：逐跳校验 HTTPS/保留地址，跨域跳转移除上游请求头 |
| **15** | **Spec (高)** | 上传在下载前锁定类型且必须手填文件名 | `src/ima.ts`<br>`src/tools.ts` | 上传流程契约测试 | PENDING_AUTH | **契约 PASS**：以实际响应 MIME 判型，并可从 Content-Disposition/URL 推断文件名 |
| **16** | **Standards (高)** | 预检失败时存在悬空管道 | `src/ima.ts` | 上传流取消契约测试 | PENDING_AUTH | **契约 PASS**：所有 IMA 前置门通过后才启动 COS 管道；失败时取消或等待管道收敛 |
| **17** | **Spec (中)** | 大型二进制只能得到不可独立使用的裸链接 | `src/stream.ts`<br>`src/ima.ts`<br>`src/tools.ts` | 媒体分块契约测试 | PENDING_AUTH | **契约 PASS**：提供有界 Base64 分块及 `next_offset/is_end` 连续读取协议 |
| **18** | **Spec (中)** | 运行时 instructions 含错误工具名和根目录规则，且缺少关键确认门 | `src/instructions.ts`<br>`companion-skill/SKILL.md` | 类型检查与 Skill 校验 | PENDING_AUTH | **静态 PASS**：已与实际工具、分页、根目录、本地图片、隐私及内容拆分规则对齐 |
| **19** | **Spec (高)** | `read_knowledge_source` 把 206 文本第一段当全文，无法续读 | `src/ima.ts`<br>`src/tools.ts` | `test/contract/knowledge-read.test.ts` | PENDING_AUTH | **契约 PASS**：URL 文本与二进制共用 Range 分块，`next_offset`/`is_end` 可续读 |
| **20** | **Spec** | 原 API `list_notebooks.version`、`list_notes.sort_type` | `src/tools.ts`<br>`companion-skill/SKILL.md` | 契约为明确放弃 | N/A | **明确放弃**：列表固定修改时间；笔记本列表只做 cursor 分页 |
| **21** | **Spec** | 原 Skill 每日更新阻断 | `src/index.ts`<br>`companion-skill/SKILL.md` | 契约为明确放弃 | N/A | **明确放弃**：不搬阻断；服务版本见 `/health` |
| **22** | **Spec** | companion 根目录导入 URL 要求传入 `knowledge_base_id` 当 `folder_id` | `companion-skill/SKILL.md`<br>`src/instructions.ts` | 静态对齐 | N/A | **静态 PASS**：根目录省略 `folder_id`，与服务端补齐一致 |

完成线（**完全迁移**）：行为/安全/失败处理等价，且真实 IMA 测试账户 E2E 覆盖新建、追加、导入 URL、关联笔记、原文续读、COS 上传。OAuth→MCP 整链不挡业务验收。live 未跑通前不得宣称完全迁移。

---

## 2. 自动化契约验证执行结果

```text
npm test
tests 47; pass 47; fail 0

npm run typecheck
tsc --noEmit: PASS

npx wrangler deploy --dry-run
bundle: PASS (731.63 KiB; gzip 148.70 KiB)

python .../skill-creator/scripts/quick_validate.py companion-skill
Skill is valid!
```

---

## 3. 真实账户集成验证说明 (Live Acceptance)

当前环境由于**未配置真实 IMA 开发者凭据**（未设置环境变量 `IMA_OPENAPI_CLIENTID` / `IMA_OPENAPI_APIKEY`），因此端到端在线集成测试套件执行了跳过策略：

```bash
$ node --experimental-strip-types --test test/e2e/runner.ts
﹣ Live IMA E2E Acceptance Suite (conditional on credentials) # 未在环境变量中检测到 IMA_OPENAPI_CLIENTID / IMA_OPENAPI_APIKEY，跳过真实账户端到端在线测试。
ℹ skipped 1
```

> [!NOTE]
> 契约测试（Mock）仅验证了客户端与云端接口数据结构的一致性、协议边缘条件及内存防御；真实环境全链路功能（Live E2E）需待用户或运维注入有效 API 凭据后方可执行。
