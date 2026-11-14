# MCP Worker ingress

Ingress and authorization belong to each independently deployed Worker. Use its current Wrangler configuration, deployed route/hostname and Portal registration as the authority, not the repository name or another Worker's URL. A configuration containing `workers_dev: false` does not imply that a custom domain is public or accessible. Preview URLs and anonymous installation assets must not weaken MCP authentication.

Maintained ingress owners:

- `browser-mcp-worker`: authenticated MCP and Profile activation; public extension download is read-only, not a pairing grant.
- `database-mcp-worker`: authenticated database operations with independent database permissions.
- `github-actions-mcp-worker`: authenticated GitHub API operations, not GitHub job authorization.
- `ima-mcp-worker`: authenticated knowledge/notes operations.
- `raindrop-mcp-worker`: authenticated bookmarks operations.
- `remote-control-mcp-worker`: authenticated owner routing and device grant checks; public native installers do not approve devices.
- `ssh-mcp-worker`: authenticated remote command/file effects with separate host authorization.
- `workflow-mcp-worker`: authenticated durable Workflow control and independently approved runtime grants.

Preserve per-Worker runtime Secrets, actual public/private route boundaries and Owner checks. A successful source build, Portal sync or read-only smoke check is not independent proof of production release or permission to execute external effects.

### Spec #878 Gateway isolation

`mcp-gateway-worker` does **not** reuse the existing `MCP_ACCESS_TOKEN` or `WORKFLOWS` Service Auth policy. A separate, initially disabled Gateway Access Service Token may be enabled only after explicit Portal + narrowly selected upstream policies, independent Clerk Resource authorization and actual tool-denial tests are verified. The Gateway never forwards the Clerk Bearer upstream. For recovery, disable only the Gateway Token or remove its dedicated Access policies; preserve existing Workflow, Portal and Raindrop connections.
