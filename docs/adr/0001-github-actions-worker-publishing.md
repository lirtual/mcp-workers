# ADR-0001: Move Worker production publishing to GitHub Actions

Status: proposed (design interview in progress). Date: 2026-10-13.

## Context

The `mcp-workers` monorepo currently has one `.github/workflows/ci.yml` for source checks. The checked-in deployment docs prescribe Cloudflare Workers Builds as the production publisher; individual apps expose Wrangler scripts and independent Worker configurations.

The maintainer has requested a change of deployment mechanism to **GitHub Actions**. This supersedes the intended Cloudflare Builds-only production publishing policy for Workers eventually included in the migration. It does **not** by itself authorize a production cutover or fix the deployment trigger policy.

## Direction explicitly requested

- Use GitHub Actions for Worker production publishing instead of relying on Cloudflare Workers Builds for those Workers.
- Preserve independently deployed Workers and existing runtime Secret values and application bindings.
- Keep the current implementation and production deployment unchanged during design.

## Known constraints

- The existing CI selects `database-mcp-worker`, `ima-mcp-worker`, and `raindrop-mcp-worker` for affected-app checks; it has no production deploy job.
- `remote-control-mcp-worker` also exists in this repository, but its committed Wrangler configuration has an all-zero VPC Service ID placeholder. The actual deployed Worker has a live VPC Service binding. A normal deploy using the checked-in placeholder is unsafe until a separate binding-preserving procedure is specified and reviewed.
- Production must not have two independent automatic publishers competing for the same Worker.
- Deployment must not copy or log runtime secret values into GitHub Actions.

## Open design decisions — not yet approved

- Which Workers enter the new publisher and whether Remote Control remains separately gated.
- Which events authorize a production deploy: main push, manual dispatch, or both.
- How the release gate relates to existing CI checks and how an affected Worker is selected.
- How Cloudflare API deployment credentials are provisioned, scoped and stored.
- The safe publisher cutover, verification and recovery procedure.

## Consequences and follow-up

Expected benefit: source checks and production publishing become visible from GitHub in one repository. Risks: an Actions credential now carries deployment authority, GitHub CI availability affects releases, and an incorrect trigger or Wrangler binding may change production behavior. The implementation and its exact trade-offs must be revised after the interview and accepted before any production action.

This record describes the migration request and verified constraints only; it is **not** an accepted implementation specification.
