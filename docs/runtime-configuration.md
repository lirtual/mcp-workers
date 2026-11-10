# Cloudflare runtime configuration

**Spec #392 and subsequent Bark-only retirement:** The legacy Weixin MCP Worker and release entry are no longer maintained in this repository. [cloudflare-actions](https://github.com/lirtual/cloudflare-actions) owns the unified Action Provider; its current executable catalog contains no Weixin send operation. Historical data and recovery evidence are governed separately and are not deleted by GitHub configuration cleanup.

The eight independently managed MCP Workers share an MCP-entry Secret **name**, not a uniform hostname, credential or logging policy. Authoritative release contracts: `.github/workflows/release.yml`, `scripts/bootstrap-worker-secrets.mjs`, `scripts/worker-release-variables.mjs`, `scripts/manual-worker-release.mjs` and each app's `wrangler.jsonc`.

Spec #392 生产 Workflow 发布的单记录历史例外：仅对 2026-10-26 的 OpenList Run `47739981-0534-4966-8034-1e79c1d17481`，在 D1 原始结果、Cloudflare 原生实例已完成，以及 GitHub Session 实际终止全部只读核对成功后，允许其不阻断发布门禁；业务状态仍是 `indeterminate`，不得重试发送或删除历史。所有其他未解决的 Run、Session 和 Attempt 保持原来的拒绝规则。该例外不构成通用忽略开关，部署不自动停止现有 Session。

## Source of truth

- Wrangler defines non-secret settings, Cloudflare bindings and required Secret names; never commit secret values.
- Under Spec #804, Browser **release code** reads `auth_domain` from the Zero Trust Organization and `aud` from the fixed reviewed Access App; Repository `OWNER_EMAIL` is its sole maintained Owner identity Variable. The former `ACCESS_TEAM_DOMAIN` and Browser Environment `BROWSER_ACTIVATION_AUDIENCE` GitHub source values remain in production Settings until separately authorized deletion after production acceptance. The GitHub Repository provides Secret `CLOUDFLARE_API_TOKEN`, the default `MCP_ACCESS_TOKEN` and Variable `CLOUDFLARE_ACCOUNT_ID`. A matching same-name GitHub Environment Secret overrides the default. Without an override, the next Worker release stages the Repository token; binding names do not establish whether deployed token values match. Shared Bearer values can widen the impact of credential disclosure, and existing Worker-specific security requirements are not waived by retaining the default.
- Every selected Worker has its own same-name GitHub Environment for app Secrets and whitelisted Variables. Only a separately approved, `main`-only, manual **Release Worker** run publishes it. Editing a GitHub Secret alone does not rotate live credentials.
- All Workers require `MCP_ACCESS_TOKEN`. `IMA_CLIENT_ID` and `WORKFLOW_MCP_PORTAL_CLIENT_ID` are required **plain-text Variables**, not Secrets.

## Worker-scoped configuration

| Worker | Additional Environment Secrets | Environment Variables |
| --- | --- | --- |
| `database-mcp-worker` | Referenced independent `DATABASE_B2B_PASSWORD` / `DATABASE_SCRAPE_RELAY_PASSWORD` Secrets | `DATABASE_CONNECTIONS`, referenced `DB_HOST`, optional `DATABASE_*` SQL limits |
| `browser-mcp-worker` | 无同名 `MCP_ACCESS_TOKEN` Environment Secret 覆盖；2026-11-06 已从 Repository Secret 重新提交并完成生产发布、现有 Portal 同步及独立只读验收 | `ACCESS_TEAM_DOMAIN`、`OWNER_EMAIL`（Repository）、`BROWSER_ACTIVATION_AUDIENCE`（Environment）；其余运行时 Browser Access 值从共享源及 Wrangler Custom Domain 派生；可选 `BROWSER_REMEMBERED_IDLE_DAYS` |
| `ima-mcp-worker` | `IMA_API_KEY` | `IMA_CLIENT_ID`、`IMA_BASE_URL` |
| `raindrop-mcp-worker` | `RAINDROP_ACCESS_TOKEN` | `RAINDROP_RATE_LIMIT_MAX_RETRIES` |
| `ssh-mcp-worker` | `SSH_ENCRYPTION_KEY`（GitHub/运行时同名） | 无 |
| `remote-control-mcp-worker` | 无 | 无 |
| `github-actions-mcp-worker` | `ACTIONS_GITHUB_DISPATCH_TOKENS` | 无 |
| `workflow-mcp-worker` | `WORKFLOW_MCP_PORTAL_CLIENT_SECRET`、`WORKFLOW_GITHUB_DISPATCH_TOKEN`；`SESSION_RUNTIME_DATA_KEY` 已按 #774 清理，不再是现行发布来源 | `WORKFLOW_MCP_PORTAL_CLIENT_ID`、`WORKFLOW_GITHUB_ACTION_APPROVED_REPOSITORIES` |

**Historical Spec #733 exception (2026-11-06, superseded):** GitHub Environment `ENCRYPTION_KEY` (SSH), `MCP_PORTAL_CLIENT_SECRET` and `SESSION_RUNTIME_DATA_KEY` (Workflow) were originally kept as release inputs and mapped to canonical Worker runtime names. The #774 UU cleanup removed `SESSION_RUNTIME_DATA_KEY`. The subsequent authorized GitHub-source-only normalization replaces the remaining two with unchanged-byte `SSH_ENCRYPTION_KEY` and `WORKFLOW_MCP_PORTAL_CLIENT_SECRET` inputs. Historical failed rename attempts and their audit evidence below remain unchanged; the source-only change does not deploy Workers or prove decryption.

Database source follows Spec #760: flat `DATABASE_CONNECTIONS`, named Direct Secrets and native Hyperdrive bindings, with no runtime D1/Setup dependency. The Owner explicitly chose #760 over conflicting Database requirements in #733. Existing production/rollback resources remain until separate authorization. See the [Database configuration and cutover contract](../apps/database-mcp-worker/README.md).

Notes: `IMA_BASE_URL`, Raindrop retry count, Browser remembered-idle override, Database limits and Workflow's `WORKFLOW_GITHUB_ACTION_APPROVED_REPOSITORIES` are optional Variables. IMA's `IMA_CLIENT_ID` and Workflow's `WORKFLOW_MCP_PORTAL_CLIENT_ID` are **required**. Workflow's approved-repositories GitHub Variable is translated to the `WORKFLOW_GITHUB_ACTION_APPROVED_REPOSITORIES` runtime binding.


For the pre-#774 Workflow runtime, `WORKFLOW_SESSION_RUNTIME_DATA_KEY` was a canonical 32-byte Base64-encoded AES-GCM key. Historical Version 142 still retains its versioned binding but is no longer active. Version 143 was published on 2026-11-07 and subsequent versions do not require that key. Its GitHub source has been deleted after #774 cleanup. SSH's `SSH_ENCRYPTION_KEY` must match the real EdgeSSH key protecting existing D1 records; the retired `SSH_BROKER_TOKEN` is not a release requirement. The legacy IMA DO binding must not be deleted during documentation maintenance. Other pinned variables (e.g. Workflow Portal endpoint and Remote Control installation origin) come from scripts or Wrangler, not arbitrary GitHub Environment input.

See [bootstrap guide](./MANUAL-WORKER-BOOTSTRAP.md) and [token rotation runbook](./mcp-shared-token-runbook.md).

## Historical GitHub configuration cleanup candidates (2026-11-05)

Current CI / Acceptance / Release Workflows and Secret / Variable staging do not consume the ten entries below. None appear in the deployed binding inventories of the eight maintained Workers. Historical release guards may still intentionally **reject** these obsolete names and must be retained. This is a *candidate inventory*, not proof that the entries were deleted or lack external/recovery consumers:

- Browser Environment Variables: `BROWSER_ACCESS_AUDIENCE`, `BROWSER_APPROVAL_ISOLATION`, `BROWSER_APPROVAL_ORIGIN`.
- Remote Control Environment Secrets: `BROWSER_APPROVAL_ACCESS_AUD`, `BROWSER_APPROVAL_ACCESS_ISSUER`, `BROWSER_APPROVAL_ALLOWED_EMAIL`.
- Workflow Environment Variable: `WEIXIN_ACTION_DEPLOYMENT_ID`; legacy Weixin Environment Secret: `WEIXIN_ENCRYPTION_KEY`.
- Repository Secrets: `DATABASE_TEST_MYSQL_PASSWORD`, `DATABASE_TEST_POSTGRES_PASSWORD` (current CI uses ephemeral database service credentials).

Before any separately authorized deletion, verify the live GitHub names/scopes plus external and recovery dependencies. Do not delete Environments, Cloudflare resources, Portal credentials, or historical receipts. No credential rotation or Worker release is part of this cleanup.

## Ingress and observability

Use [ingress policy](./ingress-policy.md) rather than deriving `workers.dev` for Workflow. Invocation logs are disabled for Remote Control, rather than having one monorepo-wide value. Never emit authentication headers, credentials, private responses or unredacted sensitive query strings to logs.

## Deployment verification

1. Verify selected GitHub Repository/Environment Secrets, Variables, branch protection and approvals. Do not use Cloudflare Builds or unreviewed direct Wrangler deploys for routine production publishing.
2. Manually dispatch **Release Worker** from current `main` with exactly one Worker selected and `deploy_to_production` explicitly approved.
3. Confirm exact Cloudflare active Version ID and required Secret/Variable/DO/D1/Service Bindings and custom-domain settings where applicable.
4. Verify public health where implemented and reject anonymous `/mcp` requests. A 401/403 alone does not prove end-to-end authenticated access.
5. Verify actual One-MCP server address, reusable Access policy IDs/order, authenticated discovery and a safe read-only call.

Git, Wrangler or README changes cannot decommission live Cloudflare resources or Portal clients. Retire them only under separate authorization and verification.

## Browser activation (current)

The Browser Worker uses https://browser.lirtual.dpdns.org as its production custom domain (workers_dev: false, preview_urls: false). Current activation uses Owner Access verification and a one-use same-Profile proof; the sole independent activation Environment Variable is BROWSER_ACTIVATION_AUDIENCE. Runtime issuer and Owner email are derived from the canonical Repository Variables, and activation origin is derived from the reviewed Wrangler Custom Domain. The independent Unknown Review page, Access application and BROWSER_APPROVAL_* runtime settings were retired; historical Unknown receipts and no-replay guards remain.

The Browser GitHub Environment was verified to have no MCP_ACCESS_TOKEN Secret override. The separately authorized [Release Worker #42137310441](https://github.com/lirtual/mcp-workers/actions/runs/42137310441) on 2026-11-06 deployed main 6c0fcd6c9fe16ac9d2a944e75be19bb37ee902fc, restaging the unchanged Repository MCP_ACCESS_TOKEN and approved Owner Variables. Independent Cloudflare readback confirmed active version a80f88bd-4f29-4660-bdf9-2df1a55f0619 (100% traffic), one MCP_ACCESS_TOKEN secret_text binding, and the derived Browser Access Variable bindings. The existing Browser Portal upstream was synchronized once without creating a new server or changing its 11-member Portal mapping; it is ready with 15 tools and reviewed UUIDv7/operation-status schemas (last successful sync 2026-11-06 00:31:39 UTC). Independent anonymous direct tools/list was denied HTTP 401. The older [Workflow Acceptance #41964023278](https://github.com/lirtual/mcp-workers/actions/runs/41964023278) had established Repository Token authenticated direct tools/list compatibility with the previously deployed version; a later [Workflow Acceptance #42174762888](https://github.com/lirtual/mcp-workers/actions/runs/42174762888) authenticated direct `tools/list` against the new Browser production version and verified its 15-tool/schema contract. A real browser operation and client E2E were **not** performed. No Secret bytes were read or compared. Future releases must recheck provenance and obtain explicit authorization for both Worker publication and Portal sync.

## Spec #733: separately authorized configuration cutover

As of 2026-11-06, the Database first production cutover passed in [Release Worker #42080572652](https://github.com/lirtual/mcp-workers/actions/runs/42080572652), including runtime names, original D1/Secret identities and safe unauthenticated checks. Its legacy GitHub Environment ACCESS_AUD was removed after exact original-value equality with DATABASE_ACCESS_AUD and independent production/readback gates ([Spec #733 cleanup receipt](https://github.com/lirtual/mcp-workers/issues/733#issuecomment-6674017036)); DATABASE_ACCESS_AUD and DATABASE_KEY_ID remained unchanged at that historical cutover. The four obsolete Database Environment entries were subsequently deleted on 2026-11-09 after the Version 46 cutover was independently verified; rollback to their old release contract is intentionally unsupported. The Browser Environment's three obsolete Variables (BROWSER_ACCESS_ISSUER, BROWSER_OWNER_EMAIL, BROWSER_ACTIVATION_ORIGIN) were independently removed, with BROWSER_ACTIVATION_AUDIENCE retained. The Browser Worker **has now been republished** under Spec #733 via [Release Worker #42137310441](https://github.com/lirtual/mcp-workers/actions/runs/42137310441); Worker and existing Portal sync passed independent production verification (active version a80f88bd-4f29-4660-bdf9-2df1a55f0619). The SSH/Workflow runtime cutovers and separately authorized legacy binding cleanup were completed later; the original GitHub Secret names were intentional release inputs until the separately authorized GitHub-source normalization (see receipts below). [Spec #733](https://github.com/lirtual/mcp-workers/issues/733) records per-stage receipts; the Issue is now closed/completed.

**SSH historical GitHub Secret rename blocked (2026-11-06; superseded by Spec #733 compatibility amendment):** The authorized protected [Seal run #42152264445](https://github.com/lirtual/mcp-workers/actions/runs/42152264445) produced a GitHub Environment public-key-encrypted, one-day-retention artifact, but the administrator's write of the new `SSH_ENCRYPTION_KEY` was **blocked by platform security controls before execution**. Independent GitHub Secret metadata still lists only the old `ENCRYPTION_KEY` (unchanged since 2026-10-25T07:40:31Z); the new Secret is absent. The two one-shot Acceptance entries and helper/test files were removed by [PR #751](https://github.com/lirtual/mcp-workers/pull/751); the [post-cleanup main CI #42153318146](https://github.com/lirtual/mcp-workers/actions/runs/42153318146) passed. The ciphertext-only artifact is scheduled to expire automatically on 2026-11-07T02:44:57Z. **Old/new GitHub Secret byte parity is no longer a requirement under the amended Spec; the later SSH production cutover and binding cleanup supersede this historical pending status (see current receipts below).** Preserve the original Secret and runtime; do not regenerate a key or bypass the blocked write. See [final audit receipt](https://github.com/lirtual/mcp-workers/issues/733#issuecomment-6676119618).

**Workflow GitHub Variables migrated (2026-11-06, PASS):** In the `workflow-mcp-worker` Environment, `MCP_PORTAL_CLIENT_ID` → `WORKFLOW_MCP_PORTAL_CLIENT_ID` and `WORKFLOW_ACTION_APPROVED_REPOSITORIES` → `WORKFLOW_GITHUB_ACTION_APPROVED_REPOSITORIES` were created with unchanged original UTF-8 bytes, independently read back and verified; the two old names were later deleted under separate authorization, after exact-value comparison and independent negative-inventory readback ([final receipt](https://github.com/lirtual/mcp-workers/issues/733#issuecomment-6687671219)). The Repository does not shadow the canonical names. The approved repository grant set and production Portal client identity were independently matched before migration. That initial Variable-copy operation did not itself release a Worker ([Spec #733 Variable migration receipt](https://github.com/lirtual/mcp-workers/issues/733#issuecomment-6676647077)). Regular Release Worker and read-only Portal Acceptance now consume only the canonical Variables; both canonical Variables and all three approved GitHub Secrets remain unchanged.

**Workflow historical GitHub Secret renames blocked (2026-11-06; superseded by Spec #733 compatibility amendment):** The Environment still contains only `MCP_PORTAL_CLIENT_SECRET`, `SESSION_RUNTIME_DATA_KEY` and `WORKFLOW_GITHUB_DISPATCH_TOKEN`; new `WORKFLOW_MCP_PORTAL_CLIENT_SECRET` and `WORKFLOW_SESSION_RUNTIME_DATA_KEY` are absent in both Environment and Repository scopes. A single protected [Portal Secret Seal #42163189775](https://github.com/lirtual/mcp-workers/actions/runs/42163189775) produced a public-key-encrypted-only one-day artifact (automatic expiry 2026-11-07 04:33:24 UTC), but the administrator's first new-Secret write was blocked by platform safety controls **before execution**. Session GitHub Secret rename and its independent parity verification were not attempted and are now superseded by the approved single-source mapping. [Cleanup PR #755](https://github.com/lirtual/mcp-workers/pull/755) restored the pre-test Workflow Acceptance definition byte-for-byte and removed the temporary helper/tests; [post-cleanup main CI #42163926090](https://github.com/lirtual/mcp-workers/actions/runs/42163926090) passed. At the time of that blocked attempt, production Workflow retained its prior active version and both legacy/canonical runtime Secret *binding names*, but binding-name presence did **not** prove original-Secret equality or completed GitHub migration. At the time of this historical failed migration, source required newly named GitHub Secrets and compared legacy bytes; the amended source instead uses the existing old-name GitHub Secrets as the sole inputs mapped to canonical runtime names. Code-only releases still do not restage Secrets. Preserve old Secrets, published Plans, historical session ciphertext, Portal identity and approved grants. Do not bypass the blocked write; the separate cutover and cleanup were subsequently authorized and completed ([historical blocked-write receipt](https://github.com/lirtual/mcp-workers/issues/733#issuecomment-6677150186); current receipts below).

The protected selected-Worker release preflight compares its effective identity with the Repository source captured by reusable CI; a separate authorized GitHub Settings inspection must verify same-name Environment variables are absent. Never rotate or expose existing Secret values during a rename. The SSH MCP `SSH_ENCRYPTION_KEY` must use the existing EdgeSSH `ENCRYPTION_KEY` bytes; the Workflow session and Portal Secrets must retain their existing values, published Plans, D1 ciphertext and target identity. Browser runtime issuer/owner/origin are derived from the Repository variables and reviewed Wrangler Custom Domain. Only newly approved GitHub Settings migration and Worker publication may change deployed bindings.

Wrangler can preserve omitted old `secret_text` names after the initial SSH/Workflow publication. Pending legacy bindings are not deletion evidence: first verify the new version and bindings, separately authorize old binding cleanup, then require independent negative Secret/binding inventory. `workflow_code_only` cannot perform the first rename migration. Unknown receipts are never replayed. See [ADR](./adr/0001-global-config-owner-names.md).

### Repository identity provenance check

The existing CI's pre-release job (which has **no** Worker GitHub Environment) captures only the Repository-resolved `OWNER_EMAIL`. The selected Browser release compares its effective Owner email with this CI output and blocks on mismatch. Browser Organization and Audience are now read-only discovered in the protected release and verified against existing active runtime bindings; they are **not** sourced from GitHub Variables. This comparison does **not** prove absence of a same-value Environment shadow. Before the first Browser production switch, the separately authorized GitHub Settings inspection and shadow cleanup were completed and independently checked (see Browser cutover evidence above). The built-in `GITHUB_TOKEN` has no assumed Variables/Environments inventory permission and is not used to claim proof.

### Spec #733: migration-original-value gates and cleanup readback

Before the separately authorized first SSH or Workflow cutover, both old and new Workflow Portal Client IDs and repository-approval lists (when present) must exactly match the original reviewed values. Database preflight compares each of the five legacy numeric limits and any already-present renamed binding against the GitHub input (falling back to the source Wrangler default). An absent legacy limit is treated as the existing original runtime default, **not** permission to change it. Wrong types, invalid values or mismatches fail before Secret staging and deployment. Database postflight additionally verifies all renamed limits and absence of unprefixed bindings. This is a code-level guard; the GitHub Settings source-value migration is not done by merging this code.

For an independently authorized *post-deletion* negative-inventory acceptance, use the existing **Workflow Acceptance** manual workflow on `main`, selecting `legacy-cleanup-readonly-ssh` or `legacy-cleanup-readonly-workflow`, with `confirm_portal_write=false` and `cleanup_expected_version` equal to the exact approved live Worker version UUID. Its separate environment-scoped job checks GitHub main SHA, performs **only Cloudflare GET** for the selected Worker's settings, Secret inventory, deployments and script settings, verifies current required bindings and forbids the old Secret names, and compares the exact active version. It never removes a Secret, updates a GitHub setting, publishes a Worker or mutates the release state file. A failed or Unknown readback must be investigated without retrying deletion. Deletion itself requires a separate approval under the existing protected release mechanism. Until successful negative-inventory evidence exists, cleanup remains **Not performed**.

**Spec #733 final production runtime-binding cleanup (2026-11-06; supersedes the historical snapshots above):**

- **SSH:** [Release Worker #42222417701](https://github.com/lirtual/mcp-workers/actions/runs/42222417701) promoted Version 11 `0cf2a9f5-078d-4811-8f92-813037deea54` to 100%; the old Cloudflare runtime `ENCRYPTION_KEY` binding is absent. Both existing RackNerd and CloudCone connections passed authenticated read-only root-directory listing. Prior Version 10 remains available for separately authorized recovery. [Independent receipt](https://github.com/lirtual/mcp-workers/issues/733#issuecomment-6685620405).
- **Workflow:** [Prepare #42225112645](https://github.com/lirtual/mcp-workers/actions/runs/42225112645) created one undeployed Version 141 candidate; the separately authorized [Publish #42226359925](https://github.com/lirtual/mcp-workers/actions/runs/42226359925) promoted `3883c6bf-0581-4e3a-8b58-ed8e5ec9f1ba` to 100%. Both old Cloudflare runtime bindings (`MCP_PORTAL_CLIENT_SECRET`, `SESSION_RUNTIME_DATA_KEY`) are absent; all 11 other bindings and original D1/Workflow/ACTIONS identities remain. Version 140 `e674d5c0-4da7-44a4-b1a9-b346409b40b3` remains available for separately authorized recovery. Authenticated `workflow_list` / `workflow_get`, 6 Active and 8 Paused Plans, HTTP 200 health and HTTP 401 anonymous MCP checks passed. [Independent receipt](https://github.com/lirtual/mcp-workers/issues/733#issuecomment-6686213244).
- **Database:** current Version 46 `c28c0af8-e773-4400-9106-425779932fcf` routes 100% and the three reviewed old runtime Secret bindings are absent. Version/binding readback and current authenticated `b2b`/`scrape_relay` Direct connection health plus bounded `SELECT 1` E2E passed. The prior legacy Database D1/AES-GCM registry decrypt is not part of the superseding Spec #760 connection path. [Current E2E receipt](https://github.com/lirtual/mcp-workers/issues/733#issuecomment-6686760458).

Under Spec #733, the three old-name **GitHub Environment Secrets** for SSH/Workflow were retained as authoritative release inputs at that time. After #774, `SESSION_RUNTIME_DATA_KEY` was deleted from GitHub; the subsequent GitHub-source normalization supersedes the remaining `ENCRYPTION_KEY` (SSH) and `MCP_PORTAL_CLIENT_SECRET` (Workflow) inputs with unchanged-byte canonical names. The Version 142 binding is historical; its pre-v21 recovery contract is not a valid post-v21 rollback plan. Workflow's production `session_runtime_data` held **zero** rows; the Owner explicitly accepted historical Session AES-GCM decryption on Version 141 as **Waived, not Pass** ([scope-limited waiver](https://github.com/lirtual/mcp-workers/issues/733#issuecomment-6687070101)). No external business Action/Session was dispatched to prove this. Older historical receipts and failed attempts remain evidence of their own point in time, not current production state. Releasing a previous version, testing with external side effects, or any further GitHub Settings mutation requires separate scope and authorization.


### Spec #774 UU 专属密钥历史快照（2026-11-07，清理前；后续已完成）

新源码已不再要求 `WORKFLOW_SESSION_RUNTIME_DATA_KEY`。正式运行的
Version 142 `414da2d7-a16f-4ce6-9350-013ad4f7166a` 仍独占 100% 流量，
保留 11 个绑定；[受控 Prepare #42341187538](https://github.com/lirtual/mcp-workers/actions/runs/42341187538)
已成功创建**未部署**的 Version 143 `3f27e9ca-790c-4ec9-914e-cb4204a736e6`，
仅移除此密钥绑定，其他 10 个绑定和代码/运行时资源一致。
[Spec #774 Publish 受阻回执](https://github.com/lirtual/mcp-workers/issues/774#issuecomment-6703786264)
记录了平台安全检查拒绝；不存在成功 Publish/Restore 回执，也不得重新派发或换路径规避。
正式 Windows Workflow 已恢复 Active。GitHub Environment 的来源
`SESSION_RUNTIME_DATA_KEY` 仍保留以保护现有活动版本及恢复依赖。

D1 仍有 20 项已应用 Migration，废弃 `session_runtime_data` 表存在且 0 行；
12 条历史 indeterminate Run、12 条未终态 Step、1 条 claimed Attempt
保持原样。[破坏性 DROP PR #777](https://github.com/lirtual/mcp-workers/pull/777)
维持 Draft/Open、不得合并或绕过原全局 Migration 强制门禁。
GitHub 来源 Secret 删除和 D1 清理均为后续独立授权事项；不得将
代码/CI、候选 Prepare 或旧版恢复入口误记为生产清理 Pass。


### 2026-11-09 配置与生产绑定最新只读核对

此节覆盖上方注明为历史快照的 #774 状态描述，不修改当时的审计证据。

- **Workflow GitHub 来源：** `workflow-mcp-worker` Environment 规范 Secrets 为 `WORKFLOW_MCP_PORTAL_CLIENT_SECRET`、`WORKFLOW_GITHUB_DISPATCH_TOKEN`；`SESSION_RUNTIME_DATA_KEY` 在 #774 获批清理后已删除。普通发布直接读取同名 GitHub Secret 作为规范运行时来源；旧 GitHub `MCP_PORTAL_CLIENT_SECRET` 已在完整字节一致性验证后删除，不再提供旧名映射或回退。
- **Workflow 现行生产：** Cloudflare 唯一 100% 活动版本为 `7b74910d-03cb-4be8-bd34-9af4146371d9`，共 10 个绑定，没有 `WORKFLOW_SESSION_RUNTIME_DATA_KEY`。历史 Version 142 `414da2d7-a16f-4ce6-9350-013ad4f7166a` 仍有旧版本化绑定，但这不证明该版本在 #774 v21 旧表清理后能够安全恢复，亦不证明密钥原值可用。#774 于 2026-11-07 完成 v21 和 GitHub 来源 Secret 清理（[生产回执](https://github.com/lirtual/mcp-workers/issues/774#issuecomment-6707337731)）及 [Windows Session E2E](https://github.com/lirtual/mcp-workers/issues/774#issuecomment-6707890211)。勿再按上方旧 143→142 恢复步骤派发。
- **Database GitHub 旧配置已删除（2026-11-09）：** `database-mcp-worker` Environment 中的 Variables `DATABASE_ACCESS_AUD`、`DATABASE_KEY_ID` 和 Secrets `DATABASE_ENCRYPTION_KEY`、`DATABASE_GITHUB_ACTIONS_TOKEN` 已通过 GitHub CLI 逐项删除，每项独立回读 Pass；该 Environment 当前为零 Variables、零 Secrets。Version 46 `c28c0af8-e773-4400-9106-425779932fcf` 继续独占 100% 流量且不含旧绑定；当前 Repository `DATABASE_CONNECTIONS`、`DATABASE_B2B_PASSWORD`、`DATABASE_SCRAPE_RELAY_PASSWORD` 等发布来源保持不变。历史版本 `eeaaaba6-3b45-4158-8537-d9989c044bd4`、`dbf5b157-ef7d-4f36-b162-62bd1b49246a` 虽留有旧绑定，但不再是受支持的恢复目标；不重建旧凭据。
- **阶段与范围：** PR #797 阶段仅只读核查并修正文档；2026-11-09 本次另获授权，只删除上述四项 GitHub Environment 旧配置，删除前后只读回读 Repository 来源及 Cloudflare 生产绑定。未读取 Secret 原值、修改 Repository 配置、生产 D1/Worker、Portal 或执行恢复。

### Spec #804 — staged Browser identity automation (code only)

Source-level Browser Release now discovers the Organization auth domain and the
fixed Browser Activation Access Application Audience on its **actual selected
Worker Runner**, validates the complete Owner-only 15m SSO+OTP policy and
compares the candidate with the independently observed active identity.
Candidate staging/recheck/readback reuse the existing protected release state.
No new Access app, policy, proxy, Cloudflare runtime credential or environment
was created; the old GitHub variable names are no longer consumed in current
CI/Release code. Do not infer this change is deployed: the first protected Runner
permission preflight, production switching, real same-Profile Owner activation
and separate GitHub source deletion still require new production authorization.

A read-only Cloudflare Access application inventory on 2026-11-10 showed
17 complete account applications (page 1/1). The Browser Activation app
`77945f97-e1ea-4b2b-b89a-ec71c0472afa` remains required and unchanged.
Two **independent Stage B** historical candidates exist:
`Database MCP Owner Setup` (`9f91a9ea-d498-49e5-9d9d-2289d1c08f65`)
guards the broader `database.lirtual.dpdns.org` domain rather than a
`/setup` route alone; **retain** until exposure/routing and real clients are
independently demonstrated safe. `Weixin MCP Setup`
(`6b025bd1-8c89-453e-8a84-b62462d81894`) covers
`weixin.lirtual.dpdns.org`; remaining traffic, DNS and consumers have not
been proven absent, so classification is **Unknown, retain**. No Access deletion
or policy change was authorized or performed. This investigation does not block
Browser Stage A code delivery.
