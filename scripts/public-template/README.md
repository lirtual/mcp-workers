# MCP Workers

Open-source Cloudflare Workers implementations of MCP servers for database access, GitHub Actions, SSH, Remote Control, IMA and Raindrop.

Each application is contained under `apps/` with its own `wrangler.jsonc`, source code and tests. Shared packages live in `packages/`.

## Set up

1. Install Node.js 24 and pnpm 10.17.1.
2. Run `pnpm install --frozen-lockfile --ignore-scripts`.
3. Select the application you want to run and review its `wrangler.jsonc`. Set **your own** Worker name, account bindings and routes. `rca.example.test` and `example-account.workers.dev` are deliberately nonfunctional test placeholders.
4. Configure runtime secrets privately through GitHub Environment Secrets / Cloudflare Secrets; never commit tokens, database URLs, device credentials or `.dev.vars`.
5. Run `pnpm --filter <worker-package-name> check` before publishing a Worker. Production deployment requires an independently reviewed workflow and credentials.

The public CI performs **checks only**. It does not deploy or require privileged GitHub/Cloudflare credentials. All real deployment environments, host identities and operational records are intentionally omitted from this public source snapshot.

The Remote Control application uses a separately versioned upstream Agent. Read `scripts/stage-public-remote-control-agent.sh` before building it.

## Security

The MCP endpoints expose powerful administration capabilities. Require authenticated access, least-privilege credentials, and explicit consent for destructive actions. Do not reuse production tokens or configure public demo instances with unrestricted SSH/shell/database access.

Report security issues privately through GitHub Security Advisories instead of publishing exploit details in an Issue.

## Licensing

See each application's `LICENSE` file where provided. Verify the licensing and provenance of the upstream components you redistribute.
