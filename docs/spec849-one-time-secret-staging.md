# Spec #849 — 一次性 Repository Secret 迁移入口（候选，未启用）

本文件只描述临时过渡工具。实际 GitHub Actions Environment → Repository 迁移仍需独立 GitHub Settings/生产敏感配置授权；提交代码、CI 通过或用户提供的模拟加密结果 **均不构成生产授权**。

## 已验证与未验证

- 用户在其 WSL 中运行纯模拟值的 GitHub CLI `--no-store` 测试，回执为 `DUMMY_ENCRYPTION_PASS`；这证明**本机 CLI 加密可用且不写入 GitHub Secret**，不验证真实密钥流。
- 在当前实现分支，本地基于 Node.js 标准库的 7 项合成数据测试通过：多行、尾部换行、CRLF、空白、Unicode、随机密文、故障/篡改拒绝。**尚未在 GitHub Runner 实际执行，不能据此声明真实 Secret 迁移通过**。
- 工作流 `.github/workflows/spec849-sealed-secret.yml` 必须先经安全审阅，按 GitHub 平台要求进入 `main` 才能 `workflow_dispatch`；仅在 PR 中无法直接验证其真实 Runner 执行。该工作流允许读取真正的旧 Environment Secret，因此**合入 main 也要事先批准该敏感能力**。
- 本项目 `main` 没有 Branch Protection / Rulesets；Repo Secret 暴露面扩大属于 Spec #849 已接受的风险，但临时工具不会获得额外的持久访问权或写入权限。

## 协议与隔离边界

`scripts/spec849-migrate-local.mjs` 由仓库 Owner 在受信任 WSL 环境**手动执行**。它生成仅保存在本地进程内存中的临时 RSA-3072 密钥对，向手动工作流分别触发两次只读密文封装：

1. `old` 运行：绑定选定的**旧 GitHub Environment**，从 `secrets[inputs.secret_name]` 获取原值，经 AES-256-GCM + RSA-OAEP 封装，只上传一天保留期的**密文 JSON**。工作流对环境名称与密钥名使用严格映射白名单，限制 Owner+main，仅有 `contents: read`。
2. 本地进程下载旧密文，在内存里解密；先再次核对 main SHA、源 Environment ID/Secret 元数据及 Repository 目标不存在，然后将旧原值仅通过标准输入交给官方 `gh secret set`，不写到命令行、标准输出、日志或明文临时文件。**只有用户明确以 `--mode=apply` 启动才写 Repository Secret。**
3. `repository` 运行：**不绑定任何 Environment**，仅从 Repository 来源读取相同名字的 Secret，再封装给同一个本地临时公钥。
4. 本地独立解密、逐字节比较两者，输出 `BYTE_EQUALITY_PASS SecretName` 或停止。比较失败时绝不删除旧 Secret；所有密文临时下载文件在完成或失败时清理。一次迁移处理六项可使用 `--secret=all`，每项顺序校验，遇到 Unknown/失败停止余项、不盲重试。

工作流本身**无 Repository Secrets 写入权限**，但经明确授权执行时可能产生常规 GitHub Environment deployment 审计记录，不发布 Cloudflare Workers，不修改 D1/Portal。

## 后续授权与最少接管步骤

1. 独立审查并批准临时工作流入口合并 main（它有读取真实 Environment Secrets 的能力）。本阶段不合并也不派发。
2. 合并后重新只读核验 main SHA、CI、Owner、精确 6 个旧 Secret、目标 Repository Secret 不存在、无在途相关 Release/Acceptance、GitHub Settings 写权限与实际平台准入；**再独立授权**原值复制到 Repository。
3. 授权后，由用户在登录的 WSL 上执行（用当时已经核对的 `<EXACT_MAIN_SHA>` 替换占位符）：

   ```bash
   cd /home/ray/workspaces/mcp-workers-spec849-secret-staging
   git fetch origin main
   node scripts/spec849-migrate-local.mjs --mode=apply --secret=all --expected-main=<EXACT_MAIN_SHA>
   ```

   不需要粘贴 Secret 原值，也不要将密文、令牌或回执以外的敏感内容发到聊天中。若出现 `SPEC849_STOP` 或任何 Unknown，**停止**，只提供非敏感 Run ID、Secret 名称和错误类别。不要重新运行 `apply`，而是先只读核验目标与来源，必要时用 `--mode=verify`（只读，不写 Secret）逐项恢复验证。
4. 6 项均 `BYTE_EQUALITY_PASS` 后，另外处理 2 个 Variables 的精确 UTF-8 原值迁移；之后删除临时工作流与迁移程序（撤销临时入口），再推进 PR #850 的消费者切换/CI，最后另行批准 10 个 GitHub Environments 删除。**禁止提前删旧来源**。

**准入状态：合成数据单测 Pass；真实 Runner Secret 读取/安全封装、GitHub Settings 写入及旧/新字节同一性均 Not run。**
