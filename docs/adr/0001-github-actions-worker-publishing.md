# ADR-0001: Move Worker production publishing to GitHub Actions

Status: proposed — design interview in progress. Date: 2026-10-13.

## Context and previous policy

The private `mcp-workers` monorepo has an existing `.github/workflows/ci.yml` for affected-app checks and Database integration tests, not deployment. The previous `docs/mcp-workers-spec.md`, `docs/runtime-configuration.md`, and application deployment guides prescribe Cloudflare Workers Builds as the sole production publisher. This architecture decision will replace that policy when implementation is approved; existing source and production deployments are unchanged in this design branch.

## Decisions confirmed by maintainer — round 1

1. **Scope (Q1=B): all four Cloudflare MCP Workers** — `database-mcp-worker`, `ima-mcp-worker`, `raindrop-mcp-worker`, and `remote-control-mcp-worker` — will migrate to GitHub Actions publishing. The local `remote-control-agent` is not itself a Cloudflare Worker, and is not made a Cloudflare deploy target by this decision.
2. **Trigger mode (Q2=C, superseded by Q12):** the original design proposed automatic publishing on relevant `main` changes plus `workflow_dispatch`. **This option is withdrawn.** See the latest, authoritative Q12 decision below.

These are settled design requirements, not authorization to cut over production now.

## Read-only reconnaissance (2026-10-13)

- The sole checked-in workflow is `.github/workflows/ci.yml`. It selectively checks Database, IMA, and Raindrop but not Remote Control, and it has no deployment job. The Remote Control package currently lacks a `check` or `deploy:dry-run` script; it exposes separate typecheck and test scripts.
- All four Worker scripts already exist in the target Cloudflare account. Cloudflare read-only API returned no Workers Builds triggers for these four Workers. This finding does **not** exclude manual or other out-of-band API deployments.
- Latest active deployment source metadata returned `wrangler` for Database/IMA and `api` for Raindrop/Remote Control.
- Actual runtime Secrets exist (names only were checked, not values):
  - Database: `MCP_ACCESS_TOKEN`, `DATABASE_CONFIG`.
  - IMA: `MCP_ACCESS_TOKEN`, `API_KEY`, `CLIENT_ID`.
  - Raindrop: `MCP_ACCESS_TOKEN`, `RAINDROP_ACCESS_TOKEN`.
  - Remote Control: `MCP_ACCESS_TOKEN`, `REMOTE_CONTROL_DEVICE_TOKEN`.
- Production resource binding names/types were found: Database `RATE_LIMITER`; IMA `IMA_IMAGE_REFRESH_SHARD` Durable Object, `R2_BUCKET` and `R2_PUBLIC_BASE_URL`; Remote Control `REMOTE_CONTROL_DEVICE` VPC service and the `REMOTE_CONTROL_ENABLE_FILE_WRITES`/`REMOTE_CONTROL_ENABLE_SHELL` runtime switches.
- Remote Control checked-in `wrangler.jsonc` uses all-zero VPC Service ID placeholder. Never deploy that configuration unmodified to production. Its production VPC identifier must be supplied via a controlled deployment-time input and binding compatibility must be verified before release.
- Each checked-in Wrangler configuration sets `keep_vars: true`, `workers_dev: true`, and `preview_urls: false`. Secrets and resource bindings must remain intact. Per Cloudflare Wrangler documentation, existing Secret values survive a normal deploy, while dashboard-managed plain vars require `keep_vars` to avoid removal.
- Do not expose real production tokens, VPC identity, SQL URLs or private responses in code, logs, or ADRs.

## Constraints to carry into implementation

- **No active automatic production publisher** for these four Workers under the target operating model. Disable or disconnect any active Cloudflare Builds trigger before the relevant manual Actions cutover; seeing zero observed triggers does not prove the absence of other external publishers.
- A deployment must preserve Worker name and URL, secrets, resource bindings, compatibility settings, and Remote Control's restrictive logging and tool-access flags.
- The GitHub Actions deployment authorization must not reuse or copy the `MCP_ACCESS_TOKEN` or upstream runtime credentials. Use a distinct constrained Cloudflare deployment token and Account ID.
- No PR-originated code or ordinary `main` push job may access production credentials. Only an explicitly invoked, allowlisted `workflow_dispatch` deployment on the trusted `main` ref may deploy.
- Never silently skip a failed test or claim production verification before observing the actual deployed version and runtime behavior.
- No unrelated framework, new CI infrastructure, new Worker, or secret-management platform is required by this migration.

## Decisions confirmed by maintainer — round 2

3. **CI and deployment gate (Q3=A): extend the existing `.github/workflows/ci.yml`.** Deployment jobs are allowed only after the corresponding existing checks pass. Extend affected-app selection and test coverage to `remote-control-mcp-worker`. Preserve the existing Database integration job and make its actual success a hard prerequisite for any Database production deploy. When a non-Database Worker deploys, an intentionally skipped Database-only integration job must not accidentally block unrelated releases or be interpreted as a passed Database test. This is a single workflow, not a second `deploy.yml` with duplicated verification.
4. **Deployment credentials (Q4=A): use GitHub `production` Environment.** Store a dedicated, least-privileged Cloudflare deployment API token as an **Environment Secret**. Use an Environment Variable for the non-secret Cloudflare Account ID as appropriate. Preserve `MCP_ACCESS_TOKEN` and upstream runtime Secrets in Cloudflare only; do not copy them into GitHub. Only the manually dispatched deploy job on trusted `main` may enter the `production` Environment; branch restrictions and optional approvals may add defense in depth, provided actual private-repository feature availability is confirmed.
5. **Remote Control VPC configuration (Q5=B): store its real VPC Service ID as a `production` Environment Variable.** Before Remote Control deploy, confirm it is non-empty, non-placeholder and exactly matches the **currently active** Cloudflare binding for `REMOTE_CONTROL_DEVICE` (and its type); fail closed on mismatch. Inject the approved ID only into a transient, ignored Wrangler configuration at deployment time; never commit the live ID, copy it to public output, or print the resolved file. Ensure the existing Secrets, `invocation_logs=false`, file-write/Shell switches and other live bindings do not regress; verify them again after deploy. This selection deliberately accepts a maintained GitHub-to-Cloudflare non-secret ID value, unlike a dynamic lookup-only design.

### Implementation prerequisites — not additional user decisions

- Current `ci.yml` has workflow-level `concurrency.cancel-in-progress: true` on the `main` group. Manual production jobs must **not share a cancellable workflow-level group** with ordinary push/PR checks. Give manual releases safe isolation and a per-Worker deploy lock; preserve check-only cancellation independently where desired.
- This is a **private** GitHub repository. Per GitHub docs, Environment Secrets and deployment-branch restrictions for private repositories require an eligible GitHub Pro, Team or Enterprise plan; verify actual repository eligibility before cutover. Do not silently fall back to Repository Secrets contrary to Q4.
- Remote Control lacks a `check` or deploy dry-run npm script and is not selected by current `ci.yml`. Add a minimal equivalent application check before enabling its release gate, retaining existing test behavior. Do not deploy the committed all-zero VPC placeholder.
- GitHub production deployment permissions must be scoped to the Cloudflare deployment function and target account; do not grant to PR checks or expose to fork-origin code.

## Decisions confirmed by maintainer — round 3

6. **Affected-app selection (Q6=A, narrowed by Q12): use change scope for CI checks, not deployment.** On PR and `main` pushes, direct `apps/<worker>/` changes check that Worker, while shared source and relevant workspace dependency/toolchain changes check affected consumers (all four is an acceptable conservative fallback). Pure documentation does not require a Worker check. This mechanism **never triggers production deployment**. A manual `workflow_dispatch` selects exactly one allowlisted Worker and **always checks that selected Worker**, regardless of which files have changed. The Remote Control Worker/Agent protocol or shared-package impact must not be wrongly omitted from checks.
7. **Per-Worker deployment serialization (Q7=A, retained): one active manual deploy for each Worker, while different Workers may deploy concurrently.** An in-progress deployment must not be cancelled by a push, another dispatch or CI check. Deploy job concurrency uses a per-Worker key with `cancel-in-progress: false`; the workflow-level cancellation setting must not override that guarantee. Manual pending runs are not FIFO-guaranteed; recheck the authorized source ref/revision at execution time and block stale, conflicting or out-of-order releases. Do not build a general-purpose deployment scheduler. The source revision and recovery exception remain open under Q11.
8. **Staged publisher migration (Q8=A, retained with manual cutover): migrate and verify one Worker at a time** in this order: **Raindrop → IMA → Database → Remote Control**. Record current active deployment and non-secret binding baseline before each transition; verify no competing automatic publisher remains; run an explicitly authorized manual Actions deployment for the selected Worker, then its acceptance checks. **There is no step to enable automatic publishing.** Remote Control is last and must satisfy existing Remote Control safety/owner approval criteria and the VPC Service ID match. This publisher migration does not approve unresolved Remote Control security/T10 release issues.
9. **Known-good source recovery (Q9=A): restore from reviewed GitHub source, rebuild, recheck, and publish as a new safe release.** No automatic `wrangler rollback` to an older Cloudflare Worker version. Recovery must use the currently authorized Secrets and compatible resource bindings. Particularly for Remote Control, do not reuse historical rotated credentials, stale VPC binding, changed invocation logging, or write/Shell flags from an older Cloudflare version. Exact mechanics for selecting the source revision are still open (Q11).

### Decision revision — Q12 (latest maintainer instruction, authoritative)

12. **Manual-only production publishing (Q12; overrides Q2 and the deployment-trigger interpretation of Q6):** four Workers deploy **only** through an explicit GitHub Actions `workflow_dispatch` selecting one allowlisted Worker. A merge/push to `main` or a pull request runs checks only and must never deploy a production Worker, regardless of changed files or shared dependencies. The earlier proposal for automatic `main` deployment, staged auto-enablement, and a production auto-deploy allowlist is **cancelled**.

### Confirmed implementation implications after Q12

- Keep **one existing** `.github/workflows/ci.yml`: `push(main)` and `pull_request` run affected-app checks only; `workflow_dispatch` validates an explicit Worker selection, executes its checks (including Database integration when selected), then and only then enters the protected `production` Environment and deploys that Worker.
- No Cloudflare deployment credential is made available to check-only jobs. The workflow must explicitly reject deploys invoked on any non-`main` ref and invalid Worker choices, even if GitHub UI allows selecting a different branch.
- Keep per-Worker serialization for manual deploy jobs only. GitHub job concurrency does not guarantee FIFO or preservation of every pending run; stale or conflicting pending deployments must not silently roll back a newer authorized release. No push-triggered deployment exists to reconcile.
- A post-deploy verification failure **must not trigger automatic rollback or another production deployment**. Mark the run failed, retain non-secret diagnostic evidence, and require an explicit manual response; whether to pause subsequent staged cutover is part of the acceptance contract.
- Use only a bounded amount of GitHub Actions and Wrangler orchestration; avoid a new durable queue, shared release database, custom deploy service, additional CI workflow or unrelated refactor.
- These requirements are architectural constraints only, not a claim that current `ci.yml` already implements them.

## Remaining decision frontier (round 4)

- **Q10 — Acceptance depth (open):** after a manual deploy, should Actions perform only safe version/binding readback, shallow health, and unauthenticated rejection checks, with a human-led Portal read-only confirmation at each cutover (recommended), or should it also hold live MCP credentials for automated authenticated end-to-end tests?
- **Q11 — Reviewed source recovery (open):** restore with a reviewed revert/recovery commit merged into `main` before a manual release (recommended), or authorize manual deployment of a specified immutable historical SHA with equivalent checks and current bindings? The ordinary manual publish path is limited to the selected Worker from trusted `main` until explicitly superseded.
- **Q13 — Post-deploy failure handling (partly settled by Q12):** no automatic recovery deploy. Remaining detail: fail the manual job and pause that Worker's next rollout/cutover pending review (recommended); record verification failure and leave human operators to decide any new release. No unreviewed historical Cloudflare rollback.

After confirming the remaining risk/acceptance choices, summarize the final contract and seek explicit design acceptance **before implementation**. No production cutover is authorized by the ADR itself.

## Consequences and trade-offs

Benefits: production publishing becomes reproducible from the same repository and commit as source checks; developers can deploy one Worker without a separate Cloudflare Builds source. Costs/risks: GitHub Actions credentials obtain production deployment authority; checks must guard the actual deployment job, not merely run in a parallel workflow; a mistaken Remote Control binding or flag can create a security/regression incident. Migrations and rollback are explicit safety-sensitive releases.

## Status and traceability

- Settled: Q1=B four Workers; **Q2=C superseded by Q12: manual-only**, no `main` auto deploy; Q3=A reuse CI; Q4=A production Environment; Q5=B Environment Variable plus live VPC check; Q6=A affected-app CI checks only; Q7=A per-Worker manual deploy serialization; Q8=A staged **manual** cutover (Raindrop → IMA → Database → Remote Control); Q9=A recovery from reviewed GitHub source; Q12=manual-only production publishing.
- Pending: Q10 acceptance depth, Q11 precise recovery source workflow, Q13 human-led response on verification failure, and final explicit design acceptance.
- Implementation: **not started**; only this proposed ADR is maintained on `design/github-actions-worker-deploy-20261013`. No `main` changes and no Cloudflare mutations authorized.
- Sources: repo `.github/workflows/ci.yml`, application package files and `wrangler.jsonc`; Cloudflare read-only Worker settings, Secrets-name, deployment and build-trigger queries; [Cloudflare GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/), [Wrangler deployment behavior](https://developers.cloudflare.com/workers/wrangler/commands/workers/), and [Workers Builds disconnect](https://developers.cloudflare.com/workers/ci-cd/builds/).
