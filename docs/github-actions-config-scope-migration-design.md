# GitHub Actions Environment 彻底退役与仓库级配置集中化

Spec: [#849](https://github.com/lirtual/mcp-workers/issues/849) — ready-for-agent，Issue 发布不代表实施或生产授权。

Status: **6/6 Secrets + 2/2 Variables 已原值迁至 Repository 且逐字节独立核验 Pass；Repository 配置现为 6 Variables / 10 Secrets，10 Environments 原样保留；PR #850 仍为 Draft，未发布生产**（2026-11-11）。Owner 已确认 Q1=B、Q2=A、Q3=A、Q4=A、Q5=A，并在设计 Spec 之后分别授权代码实施、临时迁移入口合并、六个 Secret 原值迁移及两个 Variable 原值迁移。最初只读预检和阶段性未完成事项按时间顺序保留；当前有效状态以本页末尾最新实测回执为准。风险取舍见 [ADR-0003](./adr/0003-retire-github-actions-environments.md)。

## 已确定决策

- **Q1=B**：彻底删除全部 GitHub Environments，不保留空壳；2 个 Variables、6 个 Secrets 迁至 Repository；清除全部 `job.environment` 依赖。
- **Q2=A**：接受 Repository Secrets 对本仓库所有符合条件的工作流可用，不再宣称按 Worker 隔离 GitHub 密钥。
- **Q3=A**：原 Secret 完整字节不变，不轮换、不重新生成；缺少可信迁移或独立核验路径时，该项保留原 Environment，禁止先删除。
- **Q4=A**：取消 Environment 强制人工审批，不另建审批服务；明确接受失去 GitHub 平台逐次审批的风险。
- **Q5=A**：不新增 GitHub Branch Protection、Ruleset 或审批替代系统；明确接受当前 `main` 无平台级分支保护，不把 Owner/main 运行时检查宣称为代码完整性保护。
- 此处 Environment 专指 **GitHub Actions Environment**，不涉及 Cloudflare Worker 的部署环境、运行时绑定、D1/DO、Portal 或 Access。所有 Worker 运行时键名、类型、有效值保持不变。

## 只读核验基线（2026-11-10）

- 仓库 `lirtual/mcp-workers`，`main`=`53c6412ca2a40bf11bc85171839b732779c64d5d`，public；GitHub collaborators API 返回 **1 名直接 admin**。
- 现有 Repository Variables（4）：`CLOUDFLARE_ACCOUNT_ID`、`DATABASE_CONNECTIONS`、`OWNER_EMAIL`、`WORKFLOW_GITHUB_ACTION_REPOSITORY`。
- 现有 Repository Secrets（4）：`CLOUDFLARE_API_TOKEN`、`DATABASE_B2B_PASSWORD`、`DATABASE_SCRAPE_RELAY_PASSWORD`、`MCP_ACCESS_TOKEN`。
- 待迁移的 2 Variables：`ima-mcp-worker/IMA_CLIENT_ID`、`workflow-mcp-worker/WORKFLOW_MCP_PORTAL_CLIENT_ID`。
- 待迁移的 6 Secrets：`github-actions-mcp-worker/ACTIONS_GITHUB_DISPATCH_TOKENS`、`ima-mcp-worker/IMA_API_KEY`、`raindrop-mcp-worker/RAINDROP_ACCESS_TOKEN`、`ssh-mcp-worker/SSH_ENCRYPTION_KEY`、`workflow-mcp-worker/WORKFLOW_GITHUB_DISPATCH_TOKEN`、`workflow-mcp-worker/WORKFLOW_MCP_PORTAL_CLIENT_SECRET`。
- 当前 10 个 GitHub Environments。除以上 5 个外，还有 `browser-mcp-worker`、`database-mcp-worker`、`remote-control-agent-release`、`remote-control-mcp-worker`、`weixin-mcp-worker`，均无 Environment 级配置。`remote-control-agent-release` 有 required reviewer + main 分支规则；`raindrop-mcp-worker` 有一条 branch policy；其他 8 个无部署保护规则。
- `job.environment` 共 **13 处**：`.github/workflows/release.yml` 6、`acceptance.yml` 5、`agent-release.yml` 1、`spec775-business-acceptance.yml` 1。
- `main` 分支保护 API 返回 404；repository rulesets 与对 `main` 生效的 rules 均为空。GitHub Actions 的默认 `GITHUB_TOKEN` 是 read，`allowed_actions=all`，`sha_pinning_required=false`。

## 关键风险与约束

1. **发布保护消失**：Agent Release 的 Environment 人工审核和 main 限制会被移除。现有发布工作流有 manual `workflow_dispatch`、Owner/main 和发布前检查，但不能防止有仓库写权限的人修改工作流自身。这是 Q4=A 已接受的真实风险，不得包装成“同等安全”。
2. **密钥访问范围扩大**：`release.yml` 当前引用 10 个不同 Secret、`acceptance.yml` 4 个、`spec775-business-acceptance.yml` 2 个；`ci.yml`、`agent-release.yml`、`agent-native-candidates.yml` 当前没有 `secrets.*` 引用。CI 可由 push/PR 触发；现有 CI 不读取 Secret，并不保证将来内部有写权限的分支/改动过的工作流拿不到 Repository Secrets。普通外部 Fork PR 默认拿不到 Secrets，不能把这一规则当作内部分支保护。Q2=A 已接受该边界。
3. **原值不可经 GitHub API 读取**：API 仅能读取 Secret 名称/元数据，不能直接复制明文或证明字节相同。只有经核实的平台允许路线才使用既有受保护 Runner 的内存读取/密文转移和独立字节一致性核验；拒绝输出明文、摘要或敏感凭据。平台拒绝或核验缺失时停止该项，不生成替代密钥。
4. **迁移影子来源**：在 job 仍引用 Environment 时，同名 Environment 配置可覆盖 Repository 值。绿色 CI/Release 不能证明已切到 Repository；删除原 Environment 前必须独立验证新来源，而不是凭 Secret 元数据判断原值一致。
5. **与生产部署不同**：`release.yml`、`agent-release.yml`、`acceptance.yml` 均以手动派发为主要执行入口，普通 main Push 跑 CI，不自动发布生产 Worker。GitHub Settings 的变更虽不等于 Worker 发布，但将影响下次真实发布使用的输入，仍属于生产相关敏感配置变更。

GitHub 资料：https://docs.github.com/en/code-security/reference/secret-security/secret-types ；https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments ；https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows

## 最小实施顺序（仅供未来单独授权时使用）

1. **只读预检**：重新核查 main/CI、权限、8 项有效来源、是否有同名遮蔽、相关运行中 Jobs、原始字节安全传递可行性；核查生产发布触发链及恢复基线。任何事实不明不删原配置。
2. **先复制、后切换**：2 个 Variable 精确保持 UTF-8 值；6 个 Secret 使用核实可行的安全原值复制路径。写入 Repository 后独立核对名称、类型、写入回执和字节一致性证据，Environment 原值保持不变。
3. **切换消费者代码**：移除上述 4 个工作流中的 13 处 `job.environment`，并修正 Release 密钥暂存步骤的 4 项无条件跨 Worker Secret 注入；修改必要的配置来源断言、CI 测试、现行文档/相关 CONTEXT。保留发布流程的手动触发、Owner/main、候选校验、互斥、非重放/Unknown 和发布后读回机制。合并前再次确认不会自动生产发布。
4. **无生产写入验收**：通过 workflow 语法、完整 CI、只读的 Repository 来源验证；特别确认验证 Job 未绑定 Environment、不依赖旧名遮蔽。按服务确认必填项与凭据消费路径；不得以 CI 代替生产 E2E。
5. **独立获批后退役**：确认没有仍依赖旧 Environment 的在途 Run，先按触发方式与有效权限批量分类仓库当前 495 个非 main 分支及其旧 Workflow 引用，再仅处理真正可执行的 Environment 引用；GitHub 会在引用不存在 Environment 的 Job 执行时**自动重建空 Environment**，所以不能只查当前 main。随后逐一清理旧 Environment 配置并删除全部 10 个 Environment；每项独立负清单读回。写操作 Unknown 先回读，不盲目重试。最后检查 `.github/workflows` 中零 `environment` 声明、GitHub Environments 总数为零，确认无已知可触发旧引用。
6. **分别记录状态**：文档/CI、迁移值验证、GitHub 资源删除、Cloudflare 实际生产部署是不同验收维度。未执行生产验收标记 `Waived` 或 `Not run`，不能伪称 Pass；不为本配置迁移批量重发 Worker。

不新增永久迁移服务、独立密钥代理、审批层、双源回退或额外长期变量；不改历史审计回执的原始结论。

## 最终安全与复杂度审查

**结论：在已确认 Q1–Q5 和单一直接管理员的前提下，这是最小充分的配置管理方案，但并非原安全隔离的等价替换。**

- **访问边界（已接受）：** GitHub Repository Secrets 对有权使用的同仓库工作流开放。普通 Fork PR 默认不获取 Secrets，但有写权限者可编辑内部工作流；当前 CI 不引用生产 Secret 不构成永久防线。未来增加协作者、GitHub App 写权限、PR 触发方式或调用链时需重新审查，不自动新增门禁。
- **发布边界（已接受）：** 移除 `remote-control-agent-release` 的 required reviewer 与 deployment branch policy，保留现有代码级 Owner/main/manual/candidate/发布前检查；这些检查不能替代 GitHub 的人工审批。删除 `raindrop-mcp-worker` Environment 也移除其 branch policy。
- **不可伪造的迁移证据（硬前置）：** Environment 同名 Secret 优先于 Repository Secret；依旧绑定 Environment 的绿色 Job 可能只验证旧值。六项 Secret 必须先只读证明原值传递及独立校验路径可用，经单独授权、符合平台限制的受控路线传递原始字节，独立比较新旧完整字节并确认无持久明文或临时敏感工件；任何一项不可行不得删除其旧来源。GitHub API 不提供旧明文，写入元数据及功能 smoke 不足以证明一致。受保护 Runner 路线是否可用属于未来实施预检，不是新一轮设计决策；被平台明确拒绝时停止对应操作，不能借换账号/工具绕过。特别检查多行 PAT、SSH 加密密钥及 Portal 凭据。
- **已退役 Environment 的再创建风险：** 旧分支或仍可派发的历史 Workflow 如保留 `job.environment`，执行时可能重新创建无规则、无 Secret 的同名 Environment。未来实施预检需批量分类历史分支/工作流的可达触发路径，只处理真实可执行的遗留引用（不批量删除历史分支），并在清理后读回；不为此发明后台清扫服务。
- **回退与断点（硬前置）：** 切换前保持旧 Environment 与旧值可用；Repository 值验证失败时停止，原生产 Worker 不变。删除 Environment 及其中密钥与审批规则后不能假设可自动恢复原值；在执行删除前必须有可信的已验证仓库级来源和清晰恢复依据。写操作 Unknown 时先只读消歧，绝不盲目重试。
- **审计新增 P1：按 Worker 限定敏感 Secret 的步骤注入。** 当前 Release 的「Stage selected Worker Secrets for every release」步骤在 `RAINDROP_ACCESS_TOKEN`、`IMA_API_KEY`、`ACTIONS_GITHUB_DISPATCH_TOKENS`、`WORKFLOW_GITHUB_DISPATCH_TOKEN` 四项上使用无条件 `secrets.*`，仅靠下游 `bootstrap-worker-secrets` 过滤上传文件。迁为 Repository 后，非目标 Worker 发布时，这四个值仍可能进入该步骤进程环境。实施应仅在对应 Worker 的工作流表达式条件下向该步骤注入四项，非目标提供空值；保留共享 `MCP_ACCESS_TOKEN`、现有已按 Worker 限定的密钥和下游选中 Worker 过滤。增加一项现有契约层测试，检查四项非目标 Worker 环境变量为空及目标 Worker 正常注入；不能把条件注入宣称为对恶意仓库写入者的权限隔离。
- **无多余机制：** 不新增配置代理、版本绑定、审批服务、永久双源、临时 Alias 遗留、新的生产验收矩阵或强制分支 Ruleset。保留现有发布互斥、Owner 检查、下游选中 Worker 密钥筛选和运行时安全验证；对上游四项无条件 Secret 注入作最小修正。不得把过往 `Environment` 的历史审计记录改写为“已经迁移”。
- **未来代码影响：** 除 4 份工作流 YAML 的 13 处 Environment 声明，还需更新源作用域相关测试/注释（例如 `scripts/manual-worker-release.test.mjs`、`scripts/legacy-secret-cleanup.test.mjs`、`scripts/verify-workflow-dispatch-gates.mjs`、`scripts/bootstrap-worker-secrets.mjs`）及活跃的 README/CONTEXT/运维文档；历史记录不重写。仅改配置存储作用域，不更改 Cloudflare Worker 的 `secret_text`/`plain_text` 类型及业务行为。

## 完成标准（未来实施验收，不是本次结果）

| 维度 | 通过标准 |
| --- | --- |
| 迁移来源 | 原有 4+2=6 个 Repository Variables、4+6=10 个 Repository Secrets；名称、变量值及全部 6 个 Secret 原字节经可信独立证明 |
| 代码与 CI | 现有必须通过的测试/CI 均 Pass；仓库当前工作流 0 处 `job.environment`；四项敏感 Secret 仅在对应 Worker 暂存步骤注入，非目标为空的契约测试 Pass；发布触发与 Actor/main/候选检查保留 |
| GitHub 清理 | 495 个非 main 分支按可执行入口批量分类，排除真实可触发的旧 Environment 引用；全部 10 个 Environments 删除且独立读回总数 0；没有等待审批或依赖旧 Environment 的在途任务 |
| 运行时 | 不因迁移触发 Worker/Agent 发布；现行 Cloudflare 绑定及业务数据不变，实际发布验收按另行授权或既有等价证据处理 |
| 安全取舍 | Repository Secrets 暴露范围扩大、人工审批消失、`main` 无 Branch Protection 均记录为 **Accepted risk**，不是 Pass 或已消除 |

**当前状态：Design complete / Code staged; Settings migration, Environment deletion and production acceptance pending separate authorization。** 设计基于 2026-11-10 的只读配置快照，实施前必须重新读回最新状态；如配置、权限或工作流触发链实际发生变化，只针对变化做差异评估，不自动重新开始决策访谈。

设计阶段仅产生本地设计与 ADR 草稿，未进行 GitHub Settings 或生产写入。本次后续代码实施另按 Owner 授权和独立验收记录，不把设计阶段结果宣称为迁移完成。

## Spec #849 实施阶段记录

本次仅在隔离实施分支修改工作流、现有契约测试和当前运维文档；合并前必须完成 Secret 原值安全迁移及无 Environment 来源验证。暂未改变 GitHub Secrets/Variables/Environments、Cloudflare 或生产发布。后续验收须用独立真实回执更新此处，不能提前标记来源与删除为 Pass。


## 2026-11-10 一次性 Secret 迁移链路可行性复核（只读）

**结论：配置清单与代码预检 Pass；真实 Secret 的安全搬运、允许写入和独立原字节核验均为 Blocked/Not proven。不能开始 Repository Secret 写入或 Environment 删除。** 该结论不会因 PR #850 的 CI 通过而改变。

### 核实过的前提

- Repository 当前仍是 4 Variables / 4 Secrets / 10 Environments，新增目标为 2 Variables / 6 Secrets，全部旧来源存在且目标无同名冲突；另外五个 Environment 没有变量或密钥。
- 2 个 Variable 可通过 GitHub API 获取原始 UTF-8 文本，分别有 32 和 39 个 UTF-8 字节；只读检查**未输出其值**，未来写入后仍需严格比较原值。
- 6 个 GitHub Environment Secret 仅可获取名称和元数据，**无法通过 GitHub REST API 获取旧明文或密文**。Repository 公钥可以读取，说明可以生成供官方写入端点使用的加密载荷，**不证明**读取旧值、写入获准或写入结果原字节相同。
- 当前 Actions 排队、运行、等待审批和 pending 均为 0。main 未启用分支保护/Ruleset；Repository 默认 GITHUB_TOKEN 为 read。现有 PR #850 仍是 Draft，CI 全部通过，且普通 Push 只触发 CI。远端当前共 497 个分支引用，非 main 496 个，删除之前仍需分类旧工作流可达性。
- 先前 Spec #733 的同类受保护 Runner 加密移交曾在后续管理员 GitHub Secret 写入阶段遭平台安全拒绝，不能据此声称此路径已被允许；历史的一次性辅助入口也已退役。
- 本轮尝试用**完全虚构的测试字符串**调用 GitHub CLI 仅生成加密输出（无 Settings 写入），执行请求仍遭平台安全检查拒绝。此检查记为 **Blocked，未执行**，绝不改用其他工具、账号、参数包装重试绕过。

### 最小必要的候选方案（仅设计，未获可执行证据）

1. **旧来源**：若平台正式允许，一次性受控 Runner 绑定原 Environment，在内存中读取指定的一个旧 Secret；不得输出明文、摘要、命令行参数、Runner job output、普通文件或可还原密钥材料。旧值仅可交给明确批准的安全加密/写入通道。原 Environment 及其 Secret 暂不修改。
2. **写入目标**：官方 GitHub Repository Secret 写入端点使用 Repository 公钥密文与 Key ID，必须具有明确 Settings 写入授权和平台许可；写入结果 Unknown 时只读消歧，不能重复盲写。此前平台拒绝仍有效，不以换工具或执行身份处理。
3. **独立验证**：旧 Env 来源和**不绑定任何 Environment** 的新 Repo 来源必须独立获取原值。可供审核的候选方式是将两个来源分别加密给同一受信任验证方的一次性公钥，由只在受信任验证方内存中保存私钥的进程解密、按长度及完整 UTF-8 字节精确比较，仅输出指定名称的 Pass/Fail。临时传递仅允许短保留的密文，绝不包含解密私钥、明文或哈希；验证后销毁临时材料。此双来源方案的凭据注入、密文来源真实性、工件权限和过期清理必须在真实运行前逐项评估。
4. **逐项准入**：先验证最小模拟用例（多行、尾随换行、空格、不同字节失败的负向断言），再在获批情况下逐个迁移真实 6 项。只有经过真实旧值与真实新值独立比较的项才能记 **Byte equality: Pass**；元数据、加密成功、HTTP 响应或功能 Smoke 一律不替代。
5. **最后清理**：6 项全部 Pass、2 Variables 原值 Pass、当前无 Environment 的生产消费者只读验证通过且历史分支再建风险处置完成后，另外授权删除 10 个 Environment；直到那时保留旧来源。禁止通过先删旧值来规避同名遮蔽。

**未解决的实际阻断**：目前既没有确认可用的平台允许原 Secret 原值搬运/写入路径，也没有可运行的独立旧/新字节核验入口。为避免添加不能执行、长期留在 main 的敏感迁移 Workflow，本轮**不创建一次性 Workflow、不编写真实密钥迁移程序、不存储加密工件**。待可执行路径被平台明确允许后，采用最少的临时工作流和本地验证步骤；成功之后连同临时入口一起撤销。无法验证时保持现状，并向 Owner 交接具体阻断，而不是提前合并、删除或声称完成迁移。

技术事实参考：GitHub [Secret 层级覆盖](https://docs.github.com/en/actions/reference/security/secrets)、[GitHub REST Secret API](https://docs.github.com/en/rest/actions/secrets) 以及 [Actions Secret 传递限制](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)。

## 2026-11-11 模拟加密与临时迁移入口更新

- Owner 在其 WSL 上执行使用纯虚构值的 GitHub CLI `--no-store` 命令，反馈 `DUMMY_ENCRYPTION_PASS`。这是**用户报告的本地合成值加密 Pass**；此前 Agent 工具平台拒绝的记录仍属实，不应改写为 Agent 已自行完成。
- 临时迁移工具已隔离至独立 Draft [PR #851](https://github.com/lirtual/mcp-workers/pull/851)：以 GitHub Environment 旧来源与无 Environment 的 Repository 来源分别加密给本地一次性公钥，再在本地内存中完成原字节比对。合成数据的 7 项密码学/边界测试和现有相关契约测试通过；真实 Runner 读取、GitHub Settings 写入与 6 项字节验真均尚未执行。
- 因 GitHub `workflow_dispatch` 要求工作流文件先存在默认分支，PR #851 仅供审核；**合并临时 Secret 读取入口到 main 本身需要另外明确授权**。在那之前不派发真实工作流。待获批后，运行时主分支 SHA 固定并回读；手动本地迁移工具必须显式 `--mode=apply`，遇到 Unknown 停止并只读核对。
- PR #850 继续保持 Draft，先用 PR #851 进行按原值迁移与独立验证，之后删除临时工具，再合并消费者改造，最后另行授权删除 10 个 Environments。未发生的步骤仍标记 Blocked/Not run。


## 2026-11-11 六项 Secret 迁移独立实测终态

- **Byte equality: 6/6 PASS**。经 Owner 明确授权，6 个 Environment Secret 分别从原环境读取并加密封装，由 Repository 无 Environment 的独立 Runner 读取新来源后在本机临时验证进程中完整字节比较。固定执行基线 `main=56cd7de33d7810e329f071c283a431144639aaa5`；全部 12 个最终验真 Run `completed/success`。
- 逐项回执：[IMA_API_KEY：旧 42859872080 / 新 42859958103](https://github.com/lirtual/mcp-workers/actions/runs/42859958103)、[ACTIONS_GITHUB_DISPATCH_TOKENS：旧 42860131760 / 新 42860224194](https://github.com/lirtual/mcp-workers/actions/runs/42860224194)、[RAINDROP_ACCESS_TOKEN：旧 42860318899 / 新 42860443985](https://github.com/lirtual/mcp-workers/actions/runs/42860443985)、[SSH_ENCRYPTION_KEY：旧 42860548395 / 新 42860646083](https://github.com/lirtual/mcp-workers/actions/runs/42860646083)、[WORKFLOW_GITHUB_DISPATCH_TOKEN：旧 42860747509 / 新 42860841061](https://github.com/lirtual/mcp-workers/actions/runs/42860841061)、[WORKFLOW_MCP_PORTAL_CLIENT_SECRET：旧 42860940951 / 新 42861037954](https://github.com/lirtual/mcp-workers/actions/runs/42861037954)。完整表与异常消歧见 [临时迁移审计归档](./spec849-one-time-secret-staging.md)。
- IMA 首次写入后本地验证工具失败，但旧/新加密 Run 均成功，已在目标元数据回读后通过 **只读 verify** 消歧，没有二次写入。其他五项首次复制和立即验证均成功。
- 最终只读清单：Repository Secrets **10**、Variables **4**、Environments **10**；六个旧 Secret 的原 Environment 元数据与迁移前完全一致，旧值未删、未轮换。没有在途 GitHub Actions Run；未触发任何 Cloudflare Worker 或 Agent Release。
- **临时 Secret 读取入口退役 Pass**：[PR #852](https://github.com/lirtual/mcp-workers/pull/852) 已合并至 `main=9d7094a1fe879983ffd81c5f742955b415269436`，[合并后 CI #42862728144](https://github.com/lirtual/mcp-workers/actions/runs/42862728144) 全部通过；独立回读显示临时工作流文件在 `main` 不存在，GitHub Workflow 注册列表已无该入口。迁移审计归档仍保留，临时密文工件按一天保留期自然到期；不保留长期临时 Secret 读取服务。
- **尚未完成**：两个原 Environment Variables `IMA_CLIENT_ID` 和 `WORKFLOW_MCP_PORTAL_CLIENT_ID` 迁移、PR #850 消费者切换及对应 CI、旧分支可执行风险分类、10 个 Environment 删除，以及另行判断所需的真实业务验收。本轮 Secret Pass 不代表整个 Spec #849 完成。

## 2026-11-11 两项 Environment Variable 原值迁移终态

- **2/2 Variables BYTE_EQUALITY_PASS**，经 Owner 单独授权仅迁移 `ima-mcp-worker/IMA_CLIENT_ID`（32 UTF-8 字节）与 `workflow-mcp-worker/WORKFLOW_MCP_PORTAL_CLIENT_ID`（39 UTF-8 字节）。旧值从 GitHub Environment Variables API 直接读取，在受信任执行进程内以官方 Repository Variables API 创建，随后**独立重新读取**两个 API 来源并比较 UTF-8 完整字节。未输出原值、摘要，不生成替代值，不将原值写入临时文件或命令行参数。
- 固定写入基线：`main=9d7094a1fe879983ffd81c5f742955b415269436`，[对应 CI #42862728144](https://github.com/lirtual/mcp-workers/actions/runs/42862728144) Success。GitHub API 登录身份为仓库管理员，写入前 Repository 同名 Variables 均不存在；除 PR #850 的 CI 外无在途 Actions Run。
- 逐项写入后立即回读 **Pass**；另在独立进程中重新回读旧新值及清单，`INDEPENDENT_READBACK_PASS` 两项均 Pass：`IMA_CLIENT_ID` 恰好 32 字节，旧 `updated_at=2026-10-24T18:18:26Z` 不变；`WORKFLOW_MCP_PORTAL_CLIENT_ID` 恰好 39 字节，旧 `updated_at=2026-11-06T04:07:56Z` 不变。
- 初次本地调用仅因 Repository 根路径末尾斜杠导致 GitHub GET 返回失败，错误发生在任何写入前；修正请求路径后一次完整执行成功，**两项均仅新建一次，没有重试写入或覆盖同名变量**。
- 独立终态读回：**Repository Variables=6，Secrets=10，Environments=10**，名称集合精确符合 Spec；全部旧 Environment 配置完整保留。一次性本地迁移脚本已移除；未执行 Agent/Worker 生产发布或修改 Cloudflare/Portal/D1。
- **仍待后续独立推进**：[PR #850](https://github.com/lirtual/mcp-workers/pull/850) 的消费者切换与 CI/合并、496 个历史非 `main` 分支的实际触发可达性检查（执行时重读最新分支数）、另行授权删除 10 个 Environments。**目前不能把整个 Spec #849 标记为 Completed。**

## 2026-11-11 历史分支 Environment 再建风险可达性审计（合并前）

**结论：按本次远端分支当前 tip 和实际工作流入口审查，未发现能够通过现有自动事件或在非 main 手动派发而执行旧 Environment Job 的可达路径；无需批量删除历史分支，也无需引入新锁、Ruleset 或后台清理服务。** 本结论仅是本次快照，不包含未来有人修改/强推旧分支、或有写权限者修改工作流后产生的新风险；最终删除 Environments 之前仍须复核实时状态。

- 固定审查仓库：`lirtual/mcp-workers`；审查时 `main=9d7094a1fe879983ffd81c5f742955b415269436`，PR #850 的待合并源码 `43cd2cd19a48eff7838e1dde5f44162ff2ffbff0`。从 GitHub 远端逐条枚举并获取所有 **500 个分支 tip（main 1、非 main 499）**，对 GitHub Actions 工作流树按对象 ID 去重，共 **169 个不同工作流目录快照**，逐一解析 YAML、`on` 事件、Job `environment` 和 Job `if`。解析失败 **0**。审查的是**现存分支的当前 tip**，不是每条分支所有历史提交。
- 分类（按分支、互斥）：**485** 个分支上的 Environment Job 仅对应手动 `workflow_dispatch`（或复用分类，本次无 `workflow_call` Environment Job）；**12** 个分支快照同时包含自动事件声明；**3** 个分支 tip 没有任何 Environment Job。
- 对 12 个候选自动事件逐项核对：**10** 个旧 `ci.yml` 的 `push` 限定 `main`，且唯一引用 Environment 的 `deploy` Job 同时要求 `github.event_name == 'workflow_dispatch'` 和 `github.ref == 'refs/heads/main'`；**1** 个 `weixin-provider-pin-sync.yml` 有 `repository_dispatch`，Job 要求 main ref，该工作流不在现行默认分支；**1** 个旧 `openlist-acceptance.yml` 有 `schedule`，其两个 Environment Job 仍要求手动派发与 main ref，且该文件不在现行默认分支。自动路径实际可达 Environment Job：**0**。
- 其余旧分支的手动 Release/Acceptance/Agent Release Job 都存在 `github.ref == 'refs/heads/main'` 约束，因此选非 main ref 不会进入 Environment Job。**仅有 2 个分支 tip** 尚包含临时 `spec849-sealed-secret.yml`：其旧值封装 Job 虽未独立重复 main 条件，但必须依赖前置 `preflight`（Owner + main）的成功，且临时工作流已在 [PR #852](https://github.com/lirtual/mcp-workers/pull/852) 从默认分支和登记中退役，没有仍可达的已授权入口。
- 与 GitHub 官方事件语义一致：`workflow_dispatch` 可针对分支选择，但其工作流须存在默认分支；`repository_dispatch` 与 `schedule` 只在默认分支文件上触发。参考 [GitHub Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)。仅有旧分支包含 `environment` 字符串不足以认定可自动重建 Environment。
- PR #850 待合并树的现行 **6 个工作流均不再声明 job-level `environment`**；`release.yml`、`acceptance.yml`、`agent-release.yml`、`spec775-business-acceptance.yml` 保持手动触发，`ci.yml` 的 `push` 仅针对 main。已接受的例外仍是移除 Agent Release 平台人工审批、扩大 Repository Secret 可用范围及 main 无 Branch Protection/Ruleset（见 ADR-0003）；**不应声称安全等级不变**。
- 合并 PR #850 后先回读真实 main 工作流、CI 与 Repository 6 Variables / 10 Secrets / 10 Environments；只有在**另外授权删除**且再次核对实时工作流、分支和在途/审批 Runs 后，才能串行删除 10 个 Environments 并回读目标 6/10/0。现阶段删除 **Not run**；生产 Worker E2E **Not run**。
