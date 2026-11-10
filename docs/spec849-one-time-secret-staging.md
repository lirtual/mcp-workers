# Spec #849 — 一次性 Secret 迁移审计归档

> 状态：**6/6 Secret 已迁移、真实完整字节一致性验证 Pass**。本文件是历史回执，不是可执行迁移说明。临时 Workflow 与辅助程序在本次清理变更中退役；未修改 GitHub Secrets/Variables、旧 Environment 或 Cloudflare 生产运行时。

## 迁移证明

受控执行基线：`lirtual/mcp-workers` 的 `main=56cd7de33d7810e329f071c283a431144639aaa5`，临时迁移代码来自已合并 [PR #851](https://github.com/lirtual/mcp-workers/pull/851)，合并后 CI [#42857973028](https://github.com/lirtual/mcp-workers/actions/runs/42857973028) 成功。Owner 在独立的 Settings 写入授权后，使用本地受信任 WSL 环境对每项 Secret 进行旧 Environment 来源与**无 Environment 绑定**的 Repository 来源独立加密封装，随后在本地临时私钥进程内完成完整字节比较；全过程仅记录名称、Run ID 和 Pass/Fail，不在聊天、日志或文件中保存明文、密钥哈希或可还原原值。

| Secret | 旧 Environment | 旧来源 Run | 新来源 Run | 独立字节验真 |
| --- | --- | ---: | ---: | --- |
| `IMA_API_KEY` | `ima-mcp-worker` | [42859872080](https://github.com/lirtual/mcp-workers/actions/runs/42859872080) | [42859958103](https://github.com/lirtual/mcp-workers/actions/runs/42859958103) | **Pass** |
| `ACTIONS_GITHUB_DISPATCH_TOKENS` | `github-actions-mcp-worker` | [42860131760](https://github.com/lirtual/mcp-workers/actions/runs/42860131760) | [42860224194](https://github.com/lirtual/mcp-workers/actions/runs/42860224194) | **Pass** |
| `RAINDROP_ACCESS_TOKEN` | `raindrop-mcp-worker` | [42860318899](https://github.com/lirtual/mcp-workers/actions/runs/42860318899) | [42860443985](https://github.com/lirtual/mcp-workers/actions/runs/42860443985) | **Pass** |
| `SSH_ENCRYPTION_KEY` | `ssh-mcp-worker` | [42860548395](https://github.com/lirtual/mcp-workers/actions/runs/42860548395) | [42860646083](https://github.com/lirtual/mcp-workers/actions/runs/42860646083) | **Pass** |
| `WORKFLOW_GITHUB_DISPATCH_TOKEN` | `workflow-mcp-worker` | [42860747509](https://github.com/lirtual/mcp-workers/actions/runs/42860747509) | [42860841061](https://github.com/lirtual/mcp-workers/actions/runs/42860841061) | **Pass** |
| `WORKFLOW_MCP_PORTAL_CLIENT_SECRET` | `workflow-mcp-worker` | [42860940951](https://github.com/lirtual/mcp-workers/actions/runs/42860940951) | [42861037954](https://github.com/lirtual/mcp-workers/actions/runs/42861037954) | **Pass** |

**异常及消歧**：`IMA_API_KEY` 首次写入后本地验证流程返回工具错误。首次旧/新来源 Run [42859331765](https://github.com/lirtual/mcp-workers/actions/runs/42859331765) / [42859433520](https://github.com/lirtual/mcp-workers/actions/runs/42859433520) 均成功、Repository 目标已存在；因此**没有重新写入**，仅通过新独立临时密钥运行 `verify`，得到上述两个新来源 Run 与 `BYTE_EQUALITY_PASS`。其他 5 项在写入后立即独立 Pass。没有发生密钥轮换或生成替代原值。

## 2026-11-10 17:05 UTC 最终只读回读

- Repository Secrets：**10**，包括六个新增密钥与原 4 个 Secret。GitHub API 元数据存在性与本地独立完整字节比较均通过。
- Repository Variables：**4**；`IMA_CLIENT_ID` 与 `WORKFLOW_MCP_PORTAL_CLIENT_ID` 仍在旧 Environment，**未迁移**。
- GitHub Environments：**10**，所有旧 Secret 仍在、更新时间与执行前基线一致；原 Secret 未删除。
- 最终独立验真所用 12 个 Run 均已 `completed/success`，同一 `main` SHA；GitHub Actions `queued / in_progress / waiting / pending` 均为 0。
- Cloudflare Workers、GitHub Actions 生产发布、D1/DO、Portal、Access：本轮未修改或派发。当前生产消费者仍读取旧 Environment；[PR #850](https://github.com/lirtual/mcp-workers/pull/850) 尚为 Draft。
- 所有工作流上传的工件仅含加密密文，GitHub retention-days 为 1；本地下载副本执行结束清理。**短期密文工件可能继续留存直至自动到期**，不能称为立即删除。
- 本清理仅撤销临时 `spec849-sealed-secret.yml` 及相关脚本/测试/CI 入口；保留历史审计文档和 GitHub Run 回执供后续核验。切换 2 个 Variables、PR #850 与 10 个 Environment 删除均属于后续独立实施范围。

Spec 完成标准的分项状态：**6 Secrets migrated / original bytes Pass；2 Variables pending；consumer code Draft；10 Environments intact；production release Not run。**
