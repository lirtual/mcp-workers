# ADR 0002: One verified GitHub Actions executor for Workflow MCP

- Status: Accepted for non-production implementation under [Spec #834](https://github.com/lirtual/mcp-workers/issues/834); production cutover is separately authorized.
- Date: 2026-11-10

## Context
Workflow MCP previously interpreted a JSON multi-repository allowlist and embedded the old `lirtual/github-actions` identity in multiple action, Session and callback paths. Renames and cross-account transfers must not silently adopt a new immutable GitHub repository ID.

## Decision
Use one Repository-level `WORKFLOW_GITHUB_ACTION_REPOSITORY=owner/repo` source and the existing `WORKFLOW_GITHUB_DISPATCH_TOKEN`. No list, environment override, fallback, extra DB schema, service or compatibility mode. Protected Release queries GitHub for exact `full_name`, immutable repository ID, default `main` and enabled `ci.yml` workflow ID. It retains the attested triplet in the protected release state and stages one `WORKFLOW_GITHUB_ACTION_IDENTITY` runtime binding. The runtime discovers only that repository and rejects new physical dispatch if the Published Plan's reviewed repository or ID differs. Main push CI SHA, OIDC, per-Attempt D1 fence and Unknown/no-replay logic remain intact. Historical Plans/receipts are read-only; new physical Task, Session, retry, webhook, scheduled, child or Saga operation against a retired identity is forbidden.

Retain exact pre-release active baseline for prepublication drift recheck. After publishing, independently read back the sole 100% active Worker version and the exact new identity with no legacy binding. Cross-account token access, GitHub OIDC subject, private repo permissions and Tailscale trust are external physical checks before any cutover. Old Version 143 recovery tools intentionally expect historical bindings and must *not* be used as fallback to undo this trust boundary without a new explicit recovery plan.

## Consequences
Changing executor requires a separate protected production release and explicit downstream Plan republish, not an Environment change alone. Do not infer that pushing code or passing CI completes a production migration. The executor repository's normal GitHub Actions workflow-dispatch execution remains distinct from the GitHub Actions MCP token map.
