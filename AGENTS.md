# AGENTS.md

## Agent skills

### Issue tracker

GitHub issues accessed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context layout defined by `CONTEXT-MAP.md` and app-scoped `CONTEXT.md` / ADRs. See `docs/agents/domain.md`.

### Retirement and configuration changes

When removing or renaming an active Worker, workflow, credential, binding or release entry, update its source, tests, CI, Wrangler, relevant `CONTEXT.md`/README and operator runbooks in the same PR. Check examples against the real release target and Secret/Variable types; use the existing CI contract tests for safety-critical drift. Keep applied D1 migrations and deployed Durable Object compatibility until separately verified safe to retire. Removing code is not authorization to delete GitHub Environments, Secrets, Cloudflare resources or forked upstream projects; report these as separate cleanup tasks. Passing CI is not production/Portal acceptance.

### Worker runtime compatibility

For outbound HTTP requests and other platform APIs, check the target Cloudflare Workers runtime contract before release; Node.js Fetch mocks alone do not establish Workers compatibility. Encode confirmed platform differences as a targeted regression within existing application tests (for example, Workers rejects `redirect: 'error'` before network I/O); preserve `redirect: 'manual'` and explicitly reject 3xx when credentials must never be forwarded. For external side effects, test the non-mutating production path before any real changes and distinguish request acceptance from confirmed completion; do not automatically retry an unknown outcome.
