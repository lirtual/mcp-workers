# ADR-0001: Canonical Owner identity and service-scoped MCP configuration

Status: Accepted and implemented under Spec #733 (closed/completed, 2026-11-06).

## Decision

`ACCESS_TEAM_DOMAIN` and `OWNER_EMAIL` are canonical GitHub Repository Variables for Browser and Database only, with no same-named Environment overrides. Service-specific keys use `DATABASE_`, `SSH_`, and `WORKFLOW_` prefixes. `MCP_ACCESS_TOKEN`, `ACTIONS_GITHUB_DISPATCH_TOKENS` and existing GitHub dispatch tokens stay unchanged. Database's subsequent Spec #760 supersedes its former D1/encryption configuration. Browser derives issuer/owner from the shared variables and activation origin from the reviewed Wrangler Custom Domain. Spec #733 did not rename Cloudflare D1, DO, Service Binding or Portal resource identities; Database's subsequent architectural change is governed by Spec #760.

## Migration safeguards (historical)

Code/tests/docs were merged before the separately authorized Worker cutovers and legacy Cloudflare runtime binding cleanup. Temporary source-name compatibility checks applied during migration; the final approved exception retains the three existing GitHub Environment Secrets as sole sources, mapped to canonical runtime bindings without copying their values. Preflight compares selected-Worker effective identity with the Repository values captured by the pre-release CI job. Absence of same-value Environment shadow requires a separately authorized GitHub Settings inventory check; CI comparison alone is not proof of removal. Postflight must check active version, new key types and exact names. Wrangler may preserve omitted `secret_text` bindings; tolerate only SSH `ENCRYPTION_KEY` and Workflow `MCP_PORTAL_CLIENT_SECRET` / `SESSION_RUNTIME_DATA_KEY` temporarily. They are not clean until a separately authorized cleanup is verified by negative Cloudflare inventory. `workflow_code_only` cannot be used for first cutover.

The separately approved runtime cutovers and legacy Cloudflare binding removals are complete (Spec #733). Normal Workflow release/Portal acceptance paths now take only the canonical GitHub nonsecret Variable names; the two former Workflow Environment Variable names were independently deleted after exact-value parity and negative-inventory checks ([final receipt](https://github.com/lirtual/mcp-workers/issues/733#issuecomment-6687671219)). The original GitHub Secret names were retained under the 2026-11-06 exception. A subsequent separately authorized source-only normalization supersedes the remaining SSH and Workflow Portal exceptions after original-byte parity checks; the UU Session key was retired under #774. Current GitHub inputs and runtime Secret names must match, without fallback.

## Failure and recovery

On permission, identity, Secret validation, D1/DO drift or Unknown receipt, stop without retry or data rewrite. Preserve the active version, original encryption bytes and historical Plans, runs, approvals and receipts. Any recovery publication requires the normal separate authorization, reviewed old code/bindings and current Cloudflare/GitHub state.
