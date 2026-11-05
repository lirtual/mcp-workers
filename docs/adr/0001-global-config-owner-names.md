# ADR-0001: Canonical Owner identity and service-scoped MCP configuration

Status: Accepted by Spec #733 for code; production cutover separately authorized.

## Decision

`ACCESS_TEAM_DOMAIN` and `OWNER_EMAIL` are canonical GitHub Repository Variables for Browser and Database only, with no same-named Environment overrides. Service-specific keys use `DATABASE_`, `SSH_`, and `WORKFLOW_` prefixes. `MCP_ACCESS_TOKEN`, `ACTIONS_GITHUB_DISPATCH_TOKENS`, Database encryption key names and existing GitHub dispatch tokens stay unchanged. Browser derives issuer/owner from the shared variables and activation origin from the reviewed Wrangler Custom Domain. Runtime capability, D1, DO, Service Binding and Portal identities do not change.

## Safe migration

Land only code/tests/docs before production approval. Then separately authorize either original-value GitHub Secret/Variable migration or the protected Workflow release's temporary source-name fallbacks (old GitHub Environment Secret/Variable values are supplied under canonical Worker binding names without Settings writes), each selected-Worker release, and removal of legacy bindings. Preflight compares selected-Worker effective identity with the Repository values captured by the pre-release CI job. Absence of same-value Environment shadow requires a separately authorized GitHub Settings inventory check; CI comparison alone is not proof of removal. Postflight must check active version, new key types and exact names. Wrangler may preserve omitted `secret_text` bindings; tolerate only SSH `ENCRYPTION_KEY` and Workflow `MCP_PORTAL_CLIENT_SECRET` / `SESSION_RUNTIME_DATA_KEY` temporarily. They are not clean until a separately authorized cleanup is verified by negative Cloudflare inventory. `workflow_code_only` cannot be used for first cutover.

## Failure and recovery

On permission, identity, Secret validation, D1/DO drift or Unknown receipt, stop without retry or data rewrite. Preserve the active version, original encryption bytes and historical Plans, runs, approvals and receipts. Any recovery publication requires the normal separate authorization, reviewed old code/bindings and current Cloudflare/GitHub state.
