# Seven-Worker shared MCP caller token: operator runbook

Status: preparation only. **Do not perform a live rotation merely by following this document.** Production mutation requires explicit authorization under [#123](https://github.com/lirtual/mcp-workers/issues/123). Implements ADR 0028 and [runtime config spec](./runtime-config-simplification-spec.md).

## In scope

Seven independently deployed Workers: `database-mcp-worker`, `ima-mcp-worker`, `instapaper-mcp-worker`, `openlist-mcp-worker`, `raindrop-mcp-worker`, `weread-mcp-worker` and `workflow-mcp-worker`. All require an identically **named** Cloudflare runtime Secret `MCP_ACCESS_TOKEN`, and the approved single-user deployment shares its **value**. Each Worker still has its own Cloudflare Secret binding; the name alone does not propagate values. Every existing client/Portal connector using a previous value must be accounted for.

This token authenticates only the MCP caller. Never reuse it as an upstream service token, webhook credential, administrator authorization, executor lease-signing secret, GitHub repository authorization, R2 credential, or Cloudflare API token. Compromise of the shared token exposes all seven MCP surfaces.

## Read-only preflight and stopping conditions

1. Confirm the code-only PR for #105, #121, #122, #106 passed review and checks, and that the deployed code is compatible with the intended required-secret contract. Avoid production deployment before credentials are ready.
2. Record each Worker name, deployment version, `MCP_ACCESS_TOKEN` **presence and type**, not the secret value. List connected MCP clients/Portal connections and their required update path. Never paste raw credentials into an issue, log, workflow summary, git file, or chat.
3. For Workflow, check separately the **presence** of `EXECUTOR_LEASE_SECRET`, persistent repository-scoped `GITHUB_ACTIONS_TOKEN`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and the DB/WORKFLOW/ARTIFACTS/CF_VERSION_METADATA bindings. Specifically record that production still has `R2_ACCOUNT_ID` and `R2_ACCESS_KEY_ID` stored as Secrets; both must be migrated before the code-only release can deploy. Audit running/queued/cancel-requested Attempts and the release compatibility gate, existing webhook credentials, intended minute Cron and GitHub authorization expiry/scope.
4. Confirm the exact expected client breakage window, maintenance approval, operator-held recovery record and accessible rollback Worker versions. Avoid assuming that updates to seven separate Workers are atomic.
5. **Stop** if a needed credential or client recovery mechanism is missing; if a nonterminal Attempt would be invalidated by lease-key rotation; if real webhook/connection definitions reference removed smoke-only names; or if a generated Wrangler config would clear Cron. Do not generate a fallback credential during deployment.
6. Audit the Cloudflare Git build origin and branch/path filters: the 2026-09-20 read-only inspection found `workflow-mcp-worker` linked to **`lirtual/sublink-worker`**, not `lirtual/mcp-workers`. Correct the incorrect repository linkage under separate explicit authorization before production cutover, and prevent accidental concurrent deployment from Git integration and Actions. The other Workers' non-`main` Git trigger is configured to **upload preview versions**, not automatically promote them to production. GitHub Cloudflare bot "Deployment successful" comments alone do not prove traffic was switched.

## Authorized expand/cutover (only #123)

1. Choose or create one strong token in an approved private credential store. No plaintext in Git, Wrangler `vars`, CI outputs or testing artifacts. Explicitly authorize the operation and select the target order.
2. Install that value as each Worker's **own** `MCP_ACCESS_TOKEN` runtime Secret. Record successes and errors by Worker name only. A partial rollout creates transient mismatches; pause, do not add an ad-hoc second accepted token.
3. Update all authorized Portal/client connections in a coordinated maintenance window, without exposing the value in verification transcripts. Verify each Worker accepts the chosen value and rejects missing/incorrect authorization using its existing supported MCP transport.
4. Provision distinct stable Workflow platform credentials as needed; never use a deployment-job `github.token` as `GITHUB_ACTIONS_TOKEN`. Do not replace lease keys while old Attempts need them; rotate the R2 access ID and signing secret as a **pair**.
5. Deploy the reviewed Workflow code; run two normal deployments and confirm stable tokens and leases. Verify the intended Cron and safe scheduler tick/maintenance path, separately authenticated real webhook, and an explicitly invoked GitHub OIDC/Attempt Claim → R2 end-to-end acceptance after the deploying CI job has finished. The first genuine Raindrop 09:00 occurrence is verified after #107 adds that workflow, under #108.
6. Only after checking no code/compiled registry/client needs them, remove old `SMOKE_READONLY_MCP_TOKEN`, `TRIGGER_SMOKE_WEBHOOK_TOKEN` and smoke endpoint overrides. Check a subsequent deployment does not reintroduce them.

## Failure and rollback

Stop further changes on any failure. For an interrupted shared-token rollout, restore the recorded prior **per-Worker** values and connected clients only through an authorized operation; a single rollback value is not guaranteed to fit every previous Worker. Where a compatible code rollback is required, deploy the recorded version without changing unrelated business credentials and check its scheduler/registry/active-Run compatibility before resuming. Never blindly replay a business Attempt or assume reverting code reverses downstream side effects. Keep token values in the operator's private credential store, not in issue comments.

## Redacted acceptance record

For each Worker, record name, deployment revision, MCP authenticated/unauthenticated check outcome and client reconnection outcome. For Workflow, record CI deployment run IDs, Cron presence and safe scheduler tick (real business occurrence is #108), GitHub executor run ID/conclusion, OIDC callback/Claim outcome, R2 artifact metadata (never presigned URLs), and whether the second deployment preserved credential identities. Record absence of obsolete smoke-only bindings by **name**, not values. A successful CI-only test does not establish equality of live Secret values.

## Local contract verification

`node --test scripts/mcp-entry-contract.test.mjs`

This only checks the seven repository configurations. It does not read Cloudflare Secret values, prove client connectivity, or authorize production mutation.
