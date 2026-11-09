# Spec #775：恢复准入设计与非生产验证

状态：Blocked。已决定最小入口控制落点，仍不能执行生产恢复或合并 PR #783。
依据：Version 143 的生产 Deployment SHA `3d033784fb56a409c741762c691b68935cf166fd`；本分支在该提交之后只改变了契约发布路径，没有改变准入谓词。
Issue Open、PR Draft。Release YAML 修改仍未被允许。本文件不构成 Fence Pass。

## 独立门禁

1. Release YAML 修改必须通过明确允许、可审计的正常维护通道。原平台拒绝未解除，不换工具、设备、账号或让用户代执行同一修改。
2. Admission Fence 必须覆盖全部 Run 创建与已有 reservation 的继续启动，并在恢复部署期间保持。Worker Release concurrency 只序列化发布，不封锁业务准入。
3. 固定历史 12 条 Unknown 的身份与关键状态。
4. 验证新旧恢复分支互斥、对应预检/回读执行、普通 Secret 清理预检在 code-only restore 下不执行。

全部门禁及 CI 通过、再次确认合并无生产副作用后才允许合并。生产操作另需明确具体授权。

## 源码依据与暂停方案的适用边界

- 手动 MCP（含 file 路径）、Cron、Webhook、GitHub Event 进入 WorkflowService.start。
  见 src/tools.ts、scheduled.ts、webhook.ts、github-event.ts（均在 apps/workflow-mcp-worker）。
- store.ts 的普通 Run INSERT ... SELECT 在提交时要求 Workflow
  state='active'、未删除、active_version_id 匹配。暂停可阻止已读过旧 Active 状态的请求提交新 Run。
- child-capacity.ts 的 awaited/detached child INSERT 同样要求目标 state='active'；
  两者要求父 Run 为 running。正常排空父 Run 后不能新增 child。
- 暂停不会取消已接受 Run；store.ts reconcileStart、child-capacity.ts 的 reserved
  child 启动仍可能执行 native create。必须额外核验 start_state、父子 Run、Session
  及 Native 六状态，不可只看 outcome IS NULL 或当前一页为空。
- 当前恢复 SQL 固定其他五个业务 Workflow 为 Active（5 Active / 8 Paused）。
  这与“全部暂停形成 Fence”的候选方案冲突，不能只暂停 openlist 就宣称全局排空。
- cloudflare_action_gate 约束部分 Action 的副作用预留，不等同于所有 Run 的创建 Fence。

以上为当前源码审查结果，不是 Version 143 部署源码或生产行为证明。
还需确认目标版本具有相同的准入谓词，并验证所有入口与在途请求的真实执行路径。

## 候选恢复顺序及尚缺证据

复用现有暂停能力，不新增锁服务、发布系统或版本管理机制：

1. 只读快照所有 Workflow 状态和 Published Plan 身份；只暂停本次明确授权的 Active
   集合，保留原 Paused/软删除项。生产授权必须覆盖完整集合。
2. 阻止部署窗口内的 Resume、Publish、创建/激活新 Workflow 以及直接 native create。
   当前源码未发现能把这些管理操作和 Release concurrency 统一封锁的既有机制；
   仅人工承诺不操作不能算已验证的技术 Fence。此项仍 Blocked。
3. 等待已接受的 reservation、Run、Session 和 Native 实例排空。
   12 个历史 Unknown 不重放，固定其身份/outcome，并核对相关 Step/Attempt、
   start_state 等关键状态证据；未知状态拒绝继续。
4. 部署前再次验证 Fence 和排空证据，再通过原受保护 Release Worker 恢复固定 UUID。
   仅重复查询不能消除查询与部署间的竞态；必须先证明第 2 步持续成立。
5. 回读精确版本、绑定、D1 历史与 Fence；失败/Unknown 时保持封锁并保留回执。
6. 只有回读通过才按快照恢复原 Active 集合；不得激活此前 Paused/软删除项，
   不改写 Published Plan。恢复准入本身属于另行授权的生产状态操作。

所需非生产测试：逐入口的 pause-before-INSERT 竞态；已有 reservation
在暂停后的启动与排空；部署窗口并发 Resume/Publish/Create 的拒绝；
child 父子链路；目标旧版本兼容；失败/Unknown 时不提前开放准入。
这些尚未完成，不能将本设计标成 Fence Pass。

## 本轮非生产结果

- 修复只按 Unknown 数量检查的问题：复用 REVIEWED_HISTORICAL_RUN_IDS，
  要求既有 12 个 ID 均仍为 indeterminate，拒绝新增未审核非终态，
  并拒绝 queued/running/NULL/未知 outcome。
- SQLite 回归先在原实现复现 queued Run 被放行，再验证修复；
  同数量替换历史 ID、改变历史 outcome 均拒绝。
- 在实际 Release job 条件上执行四种布尔组合与错误 Worker 的矩阵；
  检查各 preflight/readback 条件及部署前后顺序，保留原静态断言。
  该测试执行当前使用的 JavaScript 兼容布尔表达式子集，不是完整 Actions 模拟器。
- 恢复测试 8 项：5 Pass / 3 Fail。失败为尚未接通的新恢复分支、
  缺失对应 preflight/readback、原静态集成断言。没有跳过失败。
- 既有 UU Secret/表清理回归 20 项通过；git diff --check 通过。
- 2026-11-09 进一步进行一次生产 D1 **只读 SELECT**（`changes=0`、`changed_db=false`），
  取证确认历史异常 Run/未终结 Step/未终结 Attempt 分别为 12/12/1。复用 #774
  的有序 `group_concat` 审计规则，额外包含 Run 的 `start_state`，分别固定
  SHA-256 指纹（仅保存状态指纹，不保存业务输入、结果或任何凭据）。
- `verifyRestoreD1` 在数量、ID/outcome 基础上，严格比对这三个固定指纹；
  补充 SQLite 负向测试，拒绝历史 Run 的 `start_state`、`error_code`、
  Step 的 `status`、`error_code`、Attempt 的 `state` 与 `owner_run_id` 漂移。
  这些检查只保证已固定的历史异常状态未变，不构成完整 Admission Fence。
- Admission Fence、Release 集成、CI 与合并仍未完成。

## 2026-11-09：暂停边界的可执行取证

基线为 7ea92895。本轮仅非生产测试、依赖安装和文档变更，未查询 GitHub 或生产。
通过 corepack 使用仓库固定 pnpm@10.17.1、frozen lockfile、ignore-scripts 安装依赖；
首次 Cron/Webhook 测试因缺少 yaml 失败，依赖补齐后重新运行通过。

在既有 child-capacity.test.ts 和 cron.test.ts 新增 7 项测试，不改变运行代码：

| 路径 | 实际执行的验证 | 结果含义 |
| --- | --- | --- |
| 普通 Run INSERT | 从 store.ts 提取真实 SQL；Active 正控能插入；已读旧版本后先暂停，再 INSERT | 暂停在 D1 提交时阻止新 Run |
| awaited/detached child | 调用实际 reservation 函数，对已暂停目标插入 | 两种新 child reservation 均拒绝 |
| 已有 child reservation | 先调用实际 reservation，再暂停所有 Workflow，再调用实际 native start 函数 | 两种 child 均仍可启动；暂停不撤销已接受 reservation |
| 手动服务入口 | 实际 create/publish/pause/start/resume/start 调用 | Paused 拒绝新 Run，Resume 之后立即重新准入 |
| 新建 Workflow | 暂停初始 Active 集合后再实际 create/publish/start | 新 Workflow 能运行；只暂停快照集合不是全局 Fence |
| 普通 Run 重放 | SQLite 构造已提交但尚未 create 的 reservation，暂停后调用实际 start 的同 key 重放 | 原 reservation 仍可触发 native create |

child、Cron、Webhook、GitHub Event 相关测试共 42/42 Pass；
随后 Workflow 应用完整测试 548/548 Pass（零跳过），TypeScript 检查和 git diff --check 通过；
其中“已知缺口”的通过表示现有风险已被复现并固定，不能计作 Admission Fence Pass。
完整恢复集成测试的三项失败仍保留。

### 下一阶段最小实现必须满足的接口

继续复用逐 Workflow 暂停，不改变暂停原有的“允许已接受 Run 继续”语义，
也不将它冒充取消/回滚能力。在恢复编排层额外要求：

- 关闭准入必须返回精确的原状态/Plan 快照与持续封锁的证据。
  封锁期间拒绝 Resume、新 Draft 首次 Publish 导致 Active、以及任何未覆盖的 Run 入口。
  Publish 已有 Paused Workflow 会保持 Paused，但仍会改变 Plan；
  恢复窗口中同样需要封锁，以保留固定 Plan 身份。
- 排空证据必须包括新 reservation/Run/child/Session 和 native 六状态。
  历史固定指纹不能被当作允许其他新 Unknown 的例外。
- 从排空通过至回读结束，封锁不得依赖“没有人同时操作”的约定；
  并发 Resume/Create/Publish 必须有可执行的拒绝证据。
- 封锁必须覆盖新版本和目标 Version 143。仅在新源码中加判断，
  回退后旧代码不再执行该判断，不足以保持整个窗口安全。
- 部署/回读失败或 Unknown 时保留封锁与回执；不得用 finally 自动 Resume。
  解除封锁只能恢复原 Active 集合，并重新核对 Plan 身份。

## 2026-11-09 决定：入口控制落在 Worker 级 Triggers，不新增存储

现有独立入口控制不能同时盖住管理请求、Cron/事件和 Version 143。

- 生产 `workflow-mcp-worker` Version 143 对应 GitHub Deployment SHA `3d033784fb56a409c741762c691b68935cf166fd`。`child-capacity.ts`、`scheduled.ts`、`webhook.ts`、`github-event.ts`、`index.ts`、`wrangler.jsonc` 与该提交没有差异。
- `pause`、`resume`、`reconcileStart` 与该提交相同。`reconcileStart` 不检查 `state='active'`，暂停后仍可能用原 instance ID 调用 `WORKFLOW.create`。此前 7 项测试复现的 Resume、新 Workflow Publish 和已有 reservation 启动，在回退后的 Version 143 上同样存在。
- `portal_connection_auth`、`http_connection_auth` 和 `cloudflare_action_gate` 只约束各自的外部调用，不拦截 Run 创建、Resume 或 Publish。Release job 的 concurrency 只序列化发布。
- 只在新源码增加判断，回退到 Version 143 后不再执行。因此不新增 D1 状态、Migration 或第二套锁。

两个版本都会执行、且 `wrangler versions deploy` 不会改写的入口，是 Worker 级 Triggers。Cloudflare 文档规定：`wrangler deploy` 按配置替换 Cron；routes、自定义域名和 Cron 的变更要通过 `triggers deploy`。本仓库发布步骤使用 `wrangler deploy`，恢复步骤使用 `wrangler versions deploy`，两者都没有 `triggers deploy`。所以一次代码发布会按当前 `wrangler.jsonc` 重新装上 `* * * * *` 和 `workflow.lirtual.dpdns.org`，随后的版本回退不会把已移除的 Triggers 装回去，也不会在它们仍存在时移除它们。

只读门禁因此在排空观察前后各读取一次：

- `GET /workers/scripts/workflow-mcp-worker/schedules`：`schedules` 必须为数组且为空。
- `GET /workers/domains`：单页完整，且没有任何 `service` 为本 Worker 的域名。
- `GET /workers/scripts/workflow-mcp-worker/subdomain`：`enabled` 必须为 `false`。

未知形状、不完整分页或任一入口仍打开，都拒绝。这是否定当前打开入口的证据，不是全程封锁证明：两次 GET 之间仍可能有人重新打开 Triggers；当前 Release 文件也没有移除 Triggers 的步骤，且该文件修改仍被拒绝。在该步骤以可审计方式存在，并证明 `versions deploy` 不会恢复 Triggers 之前，恢复不能通过。

尚未覆盖、不能算作 Pass 的残余：账号内其他 zone route、边缘已经接受的请求，以及排空完成前 Native Workflow 对 Worker 的回调。`remote-control-mcp-worker` 的 `SessionAuthorization` 绑定不创建 Run。三项 Release 集成测试继续失败，不跳过。
