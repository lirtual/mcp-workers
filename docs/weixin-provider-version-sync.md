# Reviewed Weixin Provider → Workflow version synchronization

This is an **approved, event-driven pin synchronization**, not an additional
Cloudflare publisher or a generic send endpoint. Both repositories keep their
existing production release authority.

## Trust boundaries

1. `lirtual/cloudflare-actions` alone publishes `weixin-mcp-worker` through
   the existing main-only `Release Weixin Provider` workflow.
2. The notification-only provider handoff verifies the latest successful
   manual release and current Cloudflare Version ID, then issues one
   `reviewed_weixin_provider_release` event.
3. `.github/workflows/weixin-provider-pin-sync.yml` executes **only** on
   the consumer's default main inside GitHub Environment
   `workflow-mcp-worker`. Configure a **required reviewer** in that
   Environment; without this policy, the sync deliberately fails.
4. `scripts/sync-reviewed-weixin-provider.mjs` independently checks the
   payload against the private provider's latest successful release run,
   source commit, pinned workflow identity, current 100% Cloudflare
   deployment, original D1 and encryption Secret, and the consuming
   environment's current pin. It never trusts the event payload alone.
5. After approval, it updates **only** existing GitHub Environment
   variable `WEIXIN_ACTION_DEPLOYMENT_ID`, reads it back, and uses the
   native `GITHUB_TOKEN` to dispatch the **unchanged**
   `.github/workflows/release.yml` with the single
   `worker=workflow-mcp-worker` target. No direct Cloudflare publish
   or bypass of D1, live Session, historic unknown, native Cloudflare
   and GitHub release proofs occurs.
6. If the runtime binding and GitHub Environment variable already match,
   the event performs no mutation and no repeat release. If the release
   fails after changing the variable, do **not** infer successful cutover:
   inspect that release, leave the old runtime binding and historical
   `unknown` receipts intact, and use a separately reviewed rerun.

The receiving workflow's successful dispatch confirms only *queuing* of
the existing release. The existing release's own readback confirms runtime
cutover. This automation never starts OpenList, calls Weixin, retries a
previous unknown invocation, overwrites business receipts, or modifies
the original encryption Secret.

## One-time GitHub Environment Secrets

Configure these using **GitHub Settings → Environments** (not in a commit
or a chat message).

| Repository / Environment | Secret | Minimum scope |
|---|---|---|
| `cloudflare-actions` / `weixin-provider` | `WEIXIN_WORKFLOW_DISPATCH_TOKEN` | Fine-grained PAT or GitHub App token, `mcp-workers` **Contents: write** (repository_dispatch) |
| `mcp-workers` / `workflow-mcp-worker` | `WEIXIN_PROVIDER_PROOF_TOKEN` | Fine-grained token, `cloudflare-actions` **Actions: read** |
| `mcp-workers` / `workflow-mcp-worker` | `WEIXIN_ENVIRONMENT_WRITE_TOKEN` | Fine-grained token, `mcp-workers` **Environments: write** |

The consumer's existing `CLOUDFLARE_API_TOKEN` (read access for both
Workers), `CLOUDFLARE_ACCOUNT_ID`, and job-scoped `GITHUB_TOKEN`
with `actions: write` are reused. Do not replace the existing
`WEIXIN_ACTION_DEPLOYMENT_ID` manually once the automatic path is
approved and functioning; keep it as an auditable exact-version pin.

These are three **distinct, least-privilege** credentials, not a single
omnibus GitHub PAT. Enforce reviewer separation and protect the production
main branches. The provider handoff also uses its existing protected
`weixin-provider` Environment.

## Activation and acceptance

- Merge the provider and consumer PRs after CI. Merely merging does **not**
  activate a successful cross-repo handoff without the three Secrets
  and required reviewer protection.
- To catch up an earlier successful Provider publication without another
  live send or redeploy, use the provider's
  `Hand off reviewed Weixin Provider Version` workflow_dispatch with
  the **exact original successful release run ID** (for the 2026-10-29
  release, `40796327454`).
- Approve the protected consumer sync only after verifying release ID,
  SHA and Provider Version. Inspect its audited environment variable
  write/readback and the subsequently dispatched
  `Release Worker (workflow-mcp-worker)` run.
- The original consumer release must pass **all** active-session,
  historical indeterminate Run, physical termination, D1 and live
  deployment readback gates. If blocked, stop and investigate—never
  rewrite `unknown` or disable the gate.
- A **new** handset E2E test is separate and explicitly authorized.
  Keep machine accepted/unknown and owner-confirmed receipt distinct.

An unknown upstream result is not fixed by version synchronization.
This only removes routine copy/paste while preserving the strict
reviewed-Provider-Version trust boundary.
