# GitHub Actions MCP context

This stateless MCP Worker manages GitHub Actions exclusively using GitHub REST and existing owner Portal authentication.

`ACTIONS_GITHUB_DISPATCH_TOKENS` is one GitHub Environment Secret containing up to eight distinct PATs separated by lines. A single-line value remains supported. No `GH_TOKEN_SECONDARY`, repository allowlist variable, account switcher, JSON secret object, database, GitHub App or second Worker is required.

The Worker discovers accessible repositories independently with authenticated GitHub `GET /user/repos` on each PAT. Discovery is bounded to 200 repositories per PAT and fails closed on errors. `repositories_list` combines results and flags any ambiguous overlap. Every operation resolves the exact `owner/repo` to precisely one PAT before calling GitHub Actions. Upstream failures do not trigger write retries under another PAT. Permissions remain enforced by GitHub, not duplicated in MCP configuration.

Tools retain the current 11 discovery, dispatch, cancellation, and rerun operations. Sensitive token values and untrusted GitHub errors are never sent in MCP responses. A dispatched/cancelled acknowledgement does not establish final state.

Only the selected GitHub Actions Worker release stages `ACTIONS_GITHUB_DISPATCH_TOKENS`; other Workers are unaffected. Renaming the Secret does not change PAT values or their GitHub permissions.
