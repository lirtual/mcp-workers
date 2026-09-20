# T02 — 建立集中配置入口，兼容旧变量并迁移固定参数

Status: draft — awaiting granularity review
Priority: P1
Blocked by: None
Proposed triage label: ready-for-agent
Spec: docs/workflow-mcp/v0.1-spec.md §27.1, §28.3; docs/workflow-mcp/v0.1-scope.md operational acceptance

## 问题

固定执行器/OIDC 参数散落于 Env；直接删除变量会破坏调用路径，需要先扩展兼容入口。

## 交付范围

- 新增小型配置模块；提供固定 executor ref/workflow 和 OIDC issuer/audience/JWKS 配置，不引入通用配置框架。
- 从部署元数据自动生成 GITHUB_REPOSITORY、GITHUB_REPOSITORY_ID、R2_ACCOUNT_ID、R2_BUCKET_NAME。
- 迁移执行器、OIDC 和 R2 签名使用方；本阶段兼容旧配置，T05 负责删除旧入口。

## 验收标准

- [ ] 旧配置下调度、Claim 和签名行为保持兼容。
- [ ] 新配置可完成同样的 OIDC 校验；错误 issuer/audience/repo/workflow 仍被拒绝。
- [ ] 四个非秘密值无需用户在多处重复输入，R2_ACCOUNT_ID 的 secret→plain 迁移顺序有明确说明。
- [ ] 配置入口及部署生成脚本有针对新旧形式的有效验证。

## 边界

仅覆盖本工单的运行链路；不新增动态插件、多租户、任意代码执行或凭证保险库。不得将凭证或个人收藏正文写入仓库。生产执行与配置变更必须记录真实结果，不以测试桩通过替代线上验收。

