# ADR-0001: Move Worker production publishing to GitHub Actions

Status: proposed — design interview in progress. Date: 2026-10-13.

## Context and previous policy

The private `mcp-workers` monorepo has an existing `.github/workflows/ci.yml` for affected-app checks and Database integration tests, not deployment. The previous `docs/mcp-workers-spec.md`, `docs/runtime-configuration.md`, and application deployment guides prescribe Cloudflare Workers Builds as the sole production publisher. This architecture decision will replace that policy when implementation is approved; existing source and production deployments are unchanged in this design branch.

## Decisions confirmed by maintainer — round 1

1. **Scope (Q1=B): all four Cloudflare MCP Workers** — `database-mcp-worker`, `ima-mcp-worker`, `raindrop-mcp-worker`, and `remote-control-mcp-worker` — will migrate to GitHub Actions publishing. The local `remote-control-agent` is not itself a Cloudflare Worker, and is not made a Cloudflare deploy target by this decision.
2. **Trigger mode (Q2=C): deploy automatically on a relevant change merged/pushed to `main`, and provide `workflow_dispatch` to manually select a single Worker.** The exact safety checks and handling of changed shared dependencies are still under discussion.

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

- Exactly one active **automatic** publisher per Worker; ensure any active Workers Builds trigger is disabled/disconnected before enabling Actions for that Worker. Merely seeing zero existing triggers does not prove there are no other publishing agents.
- A deployment must preserve Worker name and URL, secrets, resource bindings, compatibility settings, and Remote Control's restrictive logging and tool-access flags.
- The GitHub Actions deployment authorization must not reuse or copy the `MCP_ACCESS_TOKEN` or upstream runtime credentials. Use a distinct constrained Cloudflare deployment token and Account ID.
- No PR-originated code is allowed to access production credentials. Deployments only from trusted `main` or approved manual runs.
- Never silently skip a failed test or claim production verification before observing the actual deployed version and runtime behavior.
- No unrelated framework, new CI infrastructure, new Worker, or secret-management platform is required by this migration.

## Decisions confirmed by maintainer — round 2

3. **CI and deployment gate (Q3=A): extend the existing `.github/workflows/ci.yml`.** Deployment jobs are allowed only after the corresponding existing checks pass. Extend affected-app selection and test coverage to `remote-control-mcp-worker`. Preserve the existing Database integration job and make its actual success a hard prerequisite for any Database production deploy. When a non-Database Worker deploys, an intentionally skipped Database-only integration job must not accidentally block unrelated releases or be interpreted as a passed Database test. This is a single workflow, not a second `deploy.yml` with duplicated verification.
4. **Deployment credentials (Q4=A): use GitHub `production` Environment.** Store a dedicated, least-privileged Cloudflare deployment API token as an **Environment Secret**. Use an Environment Variable for the non-secret Cloudflare Account ID as appropriate. Preserve `MCP_ACCESS_TOKEN` and upstream runtime Secrets in Cloudflare only; do not copy them into GitHub. Production jobs must be restricted by workflow guards to trusted `main`, and the Environment should be restricted to `main` as defense in depth. An approval rule that disables automatic deployment is not part of this accepted trigger requirement.
5. **Remote Control VPC configuration (Q5=B): store its real VPC Service ID as a `production` Environment Variable.** Before Remote Control deploy, confirm it is non-empty, non-placeholder and exactly matches the **currently active** Cloudflare binding for `REMOTE_CONTROL_DEVICE` (and its type); fail closed on mismatch. Inject the approved ID only into a transient, ignored Wrangler configuration at deployment time; never commit the live ID, copy it to public output, or print the resolved file. Ensure the existing Secrets, `invocation_logs=false`, file-write/Shell switches and other live bindings do not regress; verify them again after deploy. This selection deliberately accepts a maintained GitHub-to-Cloudflare non-secret ID value, unlike a dynamic lookup-only design.

### Implementation prerequisites — not additional user decisions

- Current `ci.yml` has workflow-level `concurrency.cancel-in-progress: true` on the `main` group. As currently written, a new push can cancel an in-progress deployment. The implementation must change or isolate this behavior before adding production jobs. The exact policy is the third-round decision Q7.
- This is a **private** GitHub repository. Per GitHub docs, Environment Secrets and deployment-branch restrictions for private repositories require an eligible GitHub Pro, Team or Enterprise plan; verify actual repository eligibility before cutover. Do not silently fall back to Repository Secrets contrary to Q4.
- Remote Control lacks a `check` or deploy dry-run npm script and is not selected by current `ci.yml`. Add a minimal equivalent application check before enabling its release gate, retaining existing test behavior. Do not deploy the committed all-zero VPC placeholder.
- GitHub production deployment permissions must be scoped to the Cloudflare deployment function and target account; do not grant to PR checks or expose to fork-origin code.

## Decision frontier (round 3 — not yet confirmed)

- **Q6: automatic changed-Worker selection.** Prefer path-based affected Worker deployment: direct app changes target that app; shared `packages/*` or dependency/toolchain changes target every affected consumer; docs-only/agent-only changes do not publish a Cloudflare Worker. Manual dispatch explicitly selects exactly one Worker and validates it against an allowlist and `main`.
- **Q7: concurrent releases / ordering.** Choose per-Worker serialization and safe handling of obsolete runs vs repository-wide serial releases. Must handle the pre-existing workflow-level cancellation setting, concurrent manual and push releases, GitHub concurrency queue semantics, and stale commits.
- **Q8: production publisher cutover.** Choose a staged, explicitly authorized pilot-to-four rollout vs activating all four at once, including verification that no competing automatic publisher is active.
- **Q9: recovery/rollback strategy.** Choose controlled re-deploy of a known-good commit with current checked production resources and credentials vs an automatic `wrangler rollback` to an older Cloudflare version. Remote Control's documented credential/binding rotation hazard means historic version rollback is not automatically safe.

Exact smoke checks, evidence and failure conditions can be finalized once Q6–Q9 are decided.

## Consequences and trade-offs

Benefits: production publishing becomes reproducible from the same repository and commit as source checks; developers can deploy one Worker without a separate Cloudflare Builds source. Costs/risks: GitHub Actions credentials obtain production deployment authority; checks must guard the actual deployment job, not merely run in a parallel workflow; a mistaken Remote Control binding or flag can create a security/regression incident. Migrations and rollback are explicit safety-sensitive releases.

## Status and traceability

- Settled: Q1=B four Workers; Q2=C auto on main and manual single Worker; Q3=A reuse CI; Q4=A production Environment; Q5=B Environment Variable with live VPC verification.
- Pending: Q6–Q9 and subsequent safe implementation/verification details; final design acceptance not yet granted.
- Implementation: **not started**; only this proposed ADR is maintained on `design/github-actions-worker-deploy-20261013`. No `main` changes and no Cloudflare mutations authorized.
- Sources: repo `.github/workflows/ci.yml`, application package files and `wrangler.jsonc`; Cloudflare read-only Worker settings, Secrets-name, deployment and build-trigger queries; [Cloudflare GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/), [Wrangler deployment behavior](https://developers.cloudflare.com/workers/wrangler/commands/workers/), and [Workers Builds disconnect](https://developers.cloudflare.com/workers/ci-cd/builds/).
