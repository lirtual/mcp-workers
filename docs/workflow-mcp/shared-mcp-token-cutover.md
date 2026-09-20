# Preserve existing shared MCP token: Workflow production migration runbook

Status: preparation only. On 2026-09-20 the operator confirmed all seven production Workers already use the **same MCP caller token value**. This is operator-confirmed, not a readable Secret-value comparison. **Do not rotate or rewrite any existing `MCP_ACCESS_TOKEN` for this migration.** Production mutation requires explicit authorization under [#123](https://github.com/lirtual/mcp-workers/issues/123). Implements ADR 0028 and [runtime config spec](./runtime-config-simplification-spec.md).

## In scope

Seven independently deployed Workers: `database-mcp-worker`, `ima-mcp-worker`, `instapaper-mcp-worker`, `openlist-mcp-worker`, `raindrop-mcp-worker`, `weread-mcp-worker` and `workflow-mcp-worker`. All require an identically **named** Cloudflare runtime Secret `MCP_ACCESS_TOKEN`, and the approved single-user deployment shares its **value**. Each Worker still has its own Cloudflare Secret binding; the name alone does not propagate values. Existing MCP clients/Portal connections already use the shared value and should remain unchanged; any discrepancy found during acceptance is a blocker to investigate, not a mandate to rotate everything.

This token authenticates only the MCP caller. Never reuse it as an upstream service token, webhook credential, administrator authorization, executor lease-signing secret, GitHub repository authorization, R2 credential, or Cloudflare API token. Compromise of the shared token exposes all seven MCP surfaces.

## Read-only preflight and stopping conditions

1. Confirm the code-only PR for #105, #121, #122, #106 passed review and checks, and that the deployed code is compatible with the intended required-secret contract. Avoid production deployment before credentials are ready.
2. Record each Worker name, deployment version, `MCP_ACCESS_TOKEN` **presence and type**, not the secret value. List existing connected MCP clients/Portal connections and confirm that they should not need any update. Never paste raw credentials into an issue, log, workflow summary, git file, or chat.
3. For Workflow, check separately the **presence** of `EXECUTOR_LEASE_SECRET`, persistent repository-scoped `GITHUB_ACTIONS_TOKEN`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and the DB/WORKFLOW/ARTIFACTS/CF_VERSION_METADATA bindings. Specifically record that production still has `R2_ACCOUNT_ID` and `R2_ACCESS_KEY_ID` stored as Secrets; both must be migrated before the code-only release can deploy. Audit running/queued/cancel-requested Attempts and the release compatibility gate, existing webhook credentials, intended minute Cron and GitHub authorization expiry/scope.
4. Confirm the no-rotation rollout, existing client continuity, change approval, and accessible rollback Worker versions. Treat any unexpected client breakage as a stop condition, not as an invitation to update all seven Worker tokens.
5. **Stop** if a needed credential or client recovery mechanism is missing; if a nonterminal Attempt would be invalidated by lease-key rotation; if real webhook/connection definitions reference removed smoke-only names; or if a generated Wrangler config would clear Cron. Do not generate a fallback credential during deployment.
6. Audit the Cloudflare Git build origin and branch/path filters: the 2026-09-20 read-only inspection found `workflow-mcp-worker` linked to **`lirtual/sublink-worker`**, not `lirtual/mcp-workers`. Correct the incorrect repository linkage under separate explicit authorization before production cutover, and prevent accidental concurrent deployment from Git integration and Actions. The other Workers' non-`main` Git trigger is configured to **upload preview versions**, not automatically promote them to production. GitHub Cloudflare bot "Deployment successful" comments alone do not prove traffic was switched.

## Authorized expand/cutover (only #123)

1. **Keep the current shared `MCP_ACCESS_TOKEN` values untouched** in all seven Workers; do not generate, synchronize, rotate, copy, or reinstall them. Keep existing MCP clients/Portal connections as-is. An authorized non-sensitive authentication check can use the already connected client plus a missing/incorrect-token rejection check without logging the actual value.
2. Confirm a persistent repository-scoped `GITHUB_ACTIONS_TOKEN` and stable `EXECUTOR_LEASE_SECRET` are provisioned independently. Never install a deployment-job `github.token` as runtime authority or replace lease keys while old Attempts need them.
3. Move the existing `R2_ACCOUNT_ID` and `R2_ACCESS_KEY_ID` *binding types* from legacy Secrets to their approved non-secret configuration while preserving the actual account and the matching R2 credential pair. The former `R2_ACCESS_KEY_ID` cannot be read back through ordinary Secret listings; obtain the correct ID from an operator-controlled secure source, not from logs or guesses. Stop if it cannot be confirmed.
4. Verify and, only if separately authorized, correct the Cloudflare Git source linkage. Check that its build trigger cannot race the independent GitHub Actions production deploy.
5. Deploy the reviewed Workflow code; run two normal deployments and confirm stable tokens and leases. Verify the intended Cron and safe scheduler tick/maintenance path, separately authenticated real webhook, and an explicitly invoked GitHub OIDC/Attempt Claim → R2 end-to-end acceptance after the deploying CI job has finished. The first genuine Raindrop 09:00 occurrence is verified after #107 adds that workflow, under #108.
6. Only after checking no code/compiled registry/client needs them, remove old `SMOKE_READONLY_MCP_TOKEN`, `TRIGGER_SMOKE_WEBHOOK_TOKEN` and smoke endpoint overrides. Check a subsequent deployment does not reintroduce them.

## Failure and rollback

Stop further changes on any failure. For this no-rotation rollout, never change existing MCP Secret values or force client reauthorization as a rollback step. If unexpected MCP authentication fails, halt and diagnose the offending deployment/configuration before making any token changes. Where a compatible code rollback is required, deploy the recorded version without changing unrelated business credentials and check its scheduler/registry/active-Run compatibility before resuming. Never blindly replay a business Attempt or assume reverting code reverses downstream side effects. Keep token values in the operator's private credential store, not in issue comments.

## Redacted acceptance record

For each Worker, record name, deployment revision and available MCP authenticated/unauthenticated check outcome, plus confirmation of continued existing client connectivity (no reconnect requirement). For Workflow, record CI deployment run IDs, Cron presence and safe scheduler tick (real business occurrence is #108), GitHub executor run ID/conclusion, OIDC callback/Claim outcome, R2 artifact metadata (never presigned URLs), and whether the second deployment preserved credential identities. Record absence of obsolete smoke-only bindings by **name**, not values. A successful CI-only test does not establish equality of live Secret values.

## Local contract verification

`node --test scripts/mcp-entry-contract.test.mjs`

This only checks the seven repository configurations. It does not read Cloudflare Secret values, prove client connectivity, or authorize production mutation. A green contract test and operator confirmation together do not constitute independent equality verification of Secret values.
