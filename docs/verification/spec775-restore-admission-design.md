# Spec #775：恢复准入设计与非生产验证

状态：Blocked / 设计候选，不能据此执行生产恢复或合并 PR #783。
依据：2026-11-09 本地工作树 HEAD 879fee9940fdd56bc3bf74d954e0fb80b33346b0。
最初仅依赖用户确认的 GitHub/生产状态基线；2026-11-09 新增一次明确标记的 D1 只读历史指纹取证。Issue Open、PR Draft 仍待独立回读确认。

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
