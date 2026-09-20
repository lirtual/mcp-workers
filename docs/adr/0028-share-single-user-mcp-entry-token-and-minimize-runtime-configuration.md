# ADR 0028: Share the single-user MCP entry token and minimize runtime configuration

- Status: Accepted (design decision; implementation pending)
- Date: 2026-09-20
- Scope: `lirtual/mcp-workers` single-user deployment; seven core MCP Workers, including Workflow MCP

## Context

The seven MCP Workers already declare `MCP_ACCESS_TOKEN` for entry authentication but independently deployed Worker secrets, upstream credentials, deployment-time smoke values and duplicated static settings create unnecessary manual configuration. The Workflow deploy job currently generates a fresh MCP token, executor lease key and smoke webhook token on every deployment, duplicates the MCP token into a smoke-only secret, and injects an ephemeral GitHub Actions job token as the Worker's outbound GitHub API credential. Its generated Wrangler config also clears the scheduler cron list.

A single shared MCP token simplifies the owner's connection management, but enlarges the scope of a compromised token. It does not justify collapsing privilege boundaries inside the Workflow service (ADR 0022).

## Decision

1. **MCP caller authentication:** All seven core MCP Workers use exactly the runtime Secret name `MCP_ACCESS_TOKEN` with the *same value* in this single-user deployment. Each Worker retains its own runtime Secret binding; the common value is provisioned or intentionally rotated across all of them. No repository-wide secret distribution service or automatic synchronization is introduced. The shared value is never embedded in Git or plaintext Wrangler variables.
2. **Authority remains distinct:** This credential authenticates only MCP client/Portal entry, not administration, executor leases, Worker-to-GitHub calls, external upstream APIs, or real webhook triggers. Other surface and upstream credentials remain separate. Do not expose raw credentials through MCP.
3. **Routine deployments:** No routine deploy regenerates or replaces production MCP/lease credentials. The normal deployment gate performs health and unauthenticated-request checks without reading or copying the production token. Full authenticated MCP, heavy execution and connection smoke tests are explicit separately invoked acceptance checks. Real CI/deployment credentials remain separate from runtime secrets.
4. **Production smoke cleanup:** Remove dedicated smoke-only webhook and `TRIGGER_SMOKE_WEBHOOK_TOKEN`, and duplicate `SMOKE_READONLY_MCP_TOKEN` from the production contract. Preserve genuine webhook capability and per-trigger authentication; do not replace it with the common MCP credential.
5. **Static inputs:** Store fixed repository identity, executor workflow/ref, OIDC issuer/JWKS/audience, resource identifiers and safe defaults once in version-controlled settings or code. Keep only genuine variable inputs and required runtime bindings. Configuration values that must be overridden for an intentionally different deployment require a documented explicit change.
6. **Platform secrets:** Maintain distinct long-lived, least-privilege Worker-to-GitHub authorization, executor lease signing and currently required R2 presigning secrets. Never use an ephemeral deployment-job `github.token` as a permanent runtime credential. Preserve the scheduled tick and all implemented D1/Workflows/R2/version bindings during reduction.

## Consequences and rollout

- Fewer independently managed MCP tokens and fewer redundant production variables; the current code and deployment configuration are **not yet migrated**.
- The compromise of one MCP entry token now grants MCP entry to all seven Workers. Rotation requires an intentionally coordinated change across all Workers and connected clients. Treat it as a cross-application credential and revisit the choice if services gain distinct users or exposure.
- No automatic per-deployment authenticated production smoke gate; run a separately authorized full acceptance check after significant changes or when investigating faults.
- The final required secret count is implementation-dependent, especially while current R2 direct-upload signing is retained. Do not hard-code a target count as a security requirement.
- Implement code, deploy workflow, Wrangler required names, smoke scripts, config references, docs and tests consistently. Check existing production dependencies and active runs before migration. Do not remove/rotate live credentials as part of documentation work.

## Relationship to prior decisions

- ADR 0022 remains accepted: its four *different trust surfaces* remain distinct. This ADR allows sharing one caller credential **across separate MCP applications in the same user-control surface**, not across those surfaces.
- ADR 0023 remains accepted: Worker-to-GitHub uses a persistent fine-grained repository token, not GitHub-to-Worker OIDC or the CI job's token.
- The v0.1 architecture reduction remains authoritative for static connections, limited DAG/runner scope and separation of upstream credential material.

## Not selected

- Independent MCP entry token values for each Worker: stronger credential isolation but more per-service management; deferred for this single-user deployment.
- Sharing the common MCP token with webhook, executor, administrator, or upstream authentication: would collapse distinct authorities.
- A new centralized secret vault/automatic propagation system: excessive complexity at this scale.
