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

## Decision frontier (round 2 — not yet confirmed)

- **Q3: CI-to-deployment gate.** Extend the current `ci.yml` with deployment jobs after all applicable checks (and add Remote Control checks), or use a second production workflow with a demonstrably equivalent gate.
- **Q4: deployment credential storage and authorization.** Select how a separate account-scoped Cloudflare deployment token and account ID are stored and which GitHub environment controls apply.
- **Q5: Remote Control VPC source and safety boundary.** Choose an ephemeral deployment-time VPC Service ID with explicit preflight/binding and feature-gate verification, or another independently reviewed preservation strategy.
- **Q6 (later):** precise auto/manual selection, same-SHA verification, ordering/race prevention, production cutover sequence, post-deploy validation and safe recovery strategy; record after the necessary upstream decisions resolve.

## Consequences and trade-offs

Benefits: production publishing becomes reproducible from the same repository and commit as source checks; developers can deploy one Worker without a separate Cloudflare Builds source. Costs/risks: GitHub Actions credentials obtain production deployment authority; checks must guard the actual deployment job, not merely run in a parallel workflow; a mistaken Remote Control binding or flag can create a security/regression incident. Migrations and rollback are explicit safety-sensitive releases.

## Status and traceability

- Settled: scope Q1=B, trigger mode Q2=C.
- Pending: Q3–Q6 above and final explicit design acceptance.
- Implementation: **not started**; only this proposed ADR is maintained on `design/github-actions-worker-deploy-20261013`. No `main` changes and no Cloudflare mutations authorized.
- Sources: repo `.github/workflows/ci.yml`, application package files and `wrangler.jsonc`; Cloudflare read-only Worker settings, Secrets-name, deployment and build-trigger queries; [Cloudflare GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/), [Wrangler deployment behavior](https://developers.cloudflare.com/workers/wrangler/commands/workers/), and [Workers Builds disconnect](https://developers.cloudflare.com/workers/ci-cd/builds/).
