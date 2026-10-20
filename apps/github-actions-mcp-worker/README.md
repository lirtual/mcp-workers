# GitHub Actions MCP Worker

A standalone Cloudflare Streamable HTTP MCP server that manages GitHub Actions through GitHub REST. No Session Deck API, D1, R2, or runner-state service is needed.

## One Secret, multiple GitHub accounts

Keep the existing GitHub Environment Secret **`GH_TOKEN`**. Its value may contain one or more fine-grained GitHub Personal Access Tokens, **one PAT per line**, for example:

```text
github_pat_<PAT_FOR_FIRST_ACCOUNT>
github_pat_<PAT_FOR_SECOND_ACCOUNT>
github_pat_<PAT_FOR_THIRD_ACCOUNT>
```

Those are placeholders, not real credentials. A single PAT on one line continues to work with no migration. The Worker supports up to **8** distinct PATs in the same Secret. The existing `MCP_ACCESS_TOKEN` remains a separate Portal authentication Secret.

No `GH_TOKEN_SECONDARY`, `GH_ACTIONS_REPOS`, `GITHUB_REPOS`, JSON wrapper, or repository-to-token map is required.

Set the permitted repositories **in each PAT's GitHub fine-grained repository access settings**. Grant repository **Metadata: Read** (for discovery), **Actions: Read/Write** when controlling workflows, and **Contents: Write** only when `repository_dispatch` is used. GitHub is the final authority for read/write permission checks.

`repositories_list` performs read-only `GET /user/repos` for each PAT and combines the accessible repositories. All existing tools still take `repo: "owner/repo"`. For actions, the Worker resolves that exact repository against the PAT discoveries before making **one** GitHub API call. If multiple PATs enumerate the same repository, the entry is reported under `ambiguous_repositories` and operations fail closed. Fix the overlap by narrowing PAT access on GitHub. A GitHub HTTP 401/403/404 never causes a mutation to retry through a different PAT.

A discovery failure or a list exceeding **200 repositories per PAT** fails closed instead of operating against partial results. The Worker does not return tokens or GitHub error bodies to MCP clients. A single secret contains all PATs, so limit who can edit/read its deployment configuration, and understand that rotating one token requires updating the composite Secret.

GitHub Actions Environment Secret values are limited to 48 KB. Avoid logging the value. The selected-Worker release workflow transfers this one `GH_TOKEN` Secret without printing its contents.

## MCP tools

The existing 11 tools are unchanged: `repositories_list`, `workflows_list`, `runs_list`, `run_get`, `run_jobs_list`, `run_artifacts_list`, `workflow_dispatch`, `repository_dispatch`, `run_cancel`, `run_force_cancel`, and `run_rerun`.

Example: `workflow_dispatch(repo="lirtual/mcp-workers", workflow="ci.yml", ref="main", inputs={"worker":"remote-control-mcp-worker"})`. The PAT that actually has permission for `lirtual/mcp-workers` is selected automatically. GitHub's accepted response does not prove that a workflow completed; use `run_get` to check.

For cancellation, `run_cancel` and `run_force_cancel` only acknowledge a request. Confirm `status=completed` and `conclusion=cancelled` via `run_get`. Force cancellation may bypass cleanup.

## Testing and release

At the repo root:

```bash
pnpm install --frozen-lockfile
pnpm --filter github-actions-mcp-worker check
```

Unit/MCP tests use synthetic PATs and never dispatch real workflows. This PR remains source-only and Draft until reviewed. Merging does not deploy: use the existing selected-Worker release workflow separately. Do not paste real PATs into code, PRs, messages, or logs.
