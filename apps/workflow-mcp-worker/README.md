# Workflow MCP Worker

Versioned, durable workflows using the existing MCP Portal, Cloudflare D1 and Cloudflare Workflows. One Worker exposes a unified set of capabilities; no separate execution stages, capability enable switches, scheduler, queue or credential issuer.

## Capabilities

- **Workflow management:** create and revise YAML/JSON Drafts, validate a bounded DAG, explicitly Publish an immutable Plan, run asynchronously (manually, via a published UTC Cron schedule, an authenticated Webhook, or a signed GitHub push relay), inspect status/results, pause/resume new admissions.
- **MCP tool calls (`mcp.call`):** read-only operations routed through the existing, server-pinned MCP Portal. Publish requires the exact endpoint, tool, `read` scope and schema digest, plus `accept_target_risks: true`. Runtime checks revalidate the published grant and live tool schema. The remote `readOnlyHint` is untrusted: network isolation and absence of remote side effects are not guaranteed.
- **GitHub Actions (`github.run`):** explicitly reviewed, repository-scoped `github.action` Task/Session definitions. A new compatible Action can be discovered from an already approved repository without redeploying the Worker. Publish still requires the exact reviewed SHA, tag, workflow, input contract and `approve_heavy_execution: true`; automatic discovery grants no execution. Task success follows the verified native GitHub terminal, not dispatch ACK or callback receipt. Optional signed Task JSON output (up to 4 KiB) is reported only after that native success. A Session completes its startup step at verified Ready, while the physical GitHub Run and cancellation/quota remain separate.
- **Result emission (`result.emit`)** for Workflow results.

No arbitrary shell input or unreviewed repository dispatch is allowed. Workflow cancellation of approved GitHub Actions is separate from stopping admission; native GitHub Run state is reconciled before a physical termination is declared.

## Runtime

The owner-facing endpoint is `https://workflow.lirtual.dpdns.org/mcp`. The existing production Portal endpoint is `https://mcp.lirtual.dpdns.org/mcp`. The Worker's MCP endpoint requires the existing Portal bearer authentication; GitHub callbacks use GitHub-issued OIDC, not the Portal bearer. External Webhooks require a distinct, scoped random Bearer token; never send the MCP owner credential to a Webhook producer.

The immutable Run Plan and status are stored in D1; Cloudflare Workflows advances the bounded DAG. Every Run is pinned to its Published Version. The target URL, tool and schema are never dynamically determined by arbitrary client inputs. External dispatch and callback state use persisted attempt IDs and verified physical GitHub Job identity.

Environment bindings and credentials:

- `DB` (`workflow-mcp-db`) and `WORKFLOW` (`workflow-mcp-orchestrator`).
- `MCP_ACCESS_TOKEN` for owner API ingress.
- `MCP_PORTAL_CLIENT_ID` / `MCP_PORTAL_CLIENT_SECRET` for the pinned Portal.
- `WORKFLOW_GITHUB_DISPATCH_TOKEN` for the registered GitHub executor.
- Release-pinned non-secret variables `MCP_PORTAL_ENDPOINT`, `GITHUB_EXECUTOR_REPOSITORY`, `GITHUB_EXECUTOR_REPOSITORY_ID`, `GITHUB_EXECUTOR_REF` and `GITHUB_EXECUTOR_AUDIENCE`.
- `GITHUB_ACTION_APPROVED_REPOSITORIES` is a server-owned JSON list of `{repository,repositoryId}` identities. A previous `commitSha` entry is tolerated but ignored for discovery. The current default-branch SHA is read from GitHub and every YAML is fetched by that exact SHA; approval of any discovered revision remains bound to the immutable Published Plan. Changing the approved repository list still requires a controlled configuration deployment.

There are **no independent capability enable flags**. The documented per-operation Publish approvals and runtime authorization checks remain mandatory.

## MCP owner tools

`workflow_capabilities`, `workflow_action_list`, `workflow_list`, `workflow_get`, `workflow_create`, `workflow_update`, `workflow_validate`, `workflow_publish`, `workflow_run`, `workflow_cancel`, `workflow_status`, `workflow_result`, `workflow_pause` and `workflow_resume`.

`workflow_capabilities` reports the current compiler's supported and unsupported Triggers, Actions and Flow Control, the structural schema, limits and compiler-checked examples. Pass an optional `id` to inspect one capability. The existing `workflow_action_list` is the sole source of discovered approved-repository GitHub Actions; neither discovery call grants execution. Connection-specific Actions are reported as `unavailable` until the service's already-approved server-side Portal or GitHub configuration is present; no secrets are returned. The current compiler supports manual admission, one UTC Cron per Published Plan, result emission, grant-bound read-only MCP, reviewed GitHub Task/Session Actions, bounded DAG dependencies and conditions. GitHub event ingress currently supports **push only**, through an explicitly installed, OIDC-signed GitHub Actions relay. It does **not** support direct GitHub webhooks, pull requests or other GitHub event types, repeat/expand, child calls or Saga. An illustrative read-only MCP example only proves the definition compiles, not that the example tool exists or has been authorized.

### Conditional branch joins

By default, a Step with `needs` runs **only when every dependency succeeded**; a skipped, failed or indeterminate dependency makes the Step skip. For intentional conditional branches, the downstream join may explicitly set `needs_policy: allow_skipped` alongside nonempty `needs`. It executes only after **all** dependencies are settled, **at least one succeeded**, and the remainder are `succeeded` or `skipped`. If every branch was skipped, the join also skips instead of dispatching a possibly privileged Action. Any `failed` or `indeterminate` dependency still blocks it; the Run retains the failure/uncertainty. The policy never retries or dispatches missing external effects. The omitted/default `all_succeeded` policy preserves existing Published Plan digests.

```json
{
  "version": 1, "name": "Branch and join", "inputs": {"choice": "left"},
  "steps": [
    {"id": "left", "uses": "result.emit", "if": {"eq": [{"ref": "inputs.choice"}, "left"]}, "with": {"data": "L"}},
    {"id": "right", "uses": "result.emit", "if": {"eq": [{"ref": "inputs.choice"}, "right"]}, "with": {"data": "R"}},
    {"id": "join", "uses": "result.emit", "needs": ["left", "right"], "needs_policy": "allow_skipped",
      "with": {"data": {"left_status": {"ref": "steps.left.status"}, "right_status": {"ref": "steps.right.status"}}}}
  ]
}
```

This is a static DAG branch fan-in, **not** dynamic `foreach`, while/repeat, subworkflow or Saga. No new Worker, D1 schema, scheduler or approval mechanism is involved.

`workflow_validate` accepts either `{workflow_id, revision}` for a saved Draft or `{definition}` with inline YAML/JSON. Inline validation uses the same compiler and reviewed Action checks, returns required Publish approvals or bounded structured issues, and never creates a Draft, writes D1, publishes, or dispatches external jobs. The two input modes cannot be combined. For a new workflow, validate inline before `workflow_create`.

A Cron schedule is optional in the Definition: `triggers: [{type: cron, schedule: '0 9 * * 1-5'}]`. This means 09:00 **UTC** on weekdays; no timezone/DST conversion is promised. Supported five-field syntax: `*`, numbers, comma lists, numeric ranges and `/` steps; names and Quartz special forms are rejected. A single `* * * * *` Cloudflare scheduled event on the existing Worker admits due versions through the same immutable Published Plan and normal eight-Run quota. Each observed minute has a durable idempotency key. **Platform-missed minutes and capacity-rejected minutes are not backfilled or queued**; monitor run history for skipped periods. Cron never adds an extra scheduler, service or D1 migration. Publishing is explicit; saving a Draft never starts execution. `workflow_pause` prevents new admissions but does not stop an active Run or automatically cancel an external Job.

## Authenticated Webhook Trigger

A Published Plan may have exactly one Trigger: Cron, Webhook or GitHub push relay (manual admission remains separately available). To provision a Webhook, generate a **fresh 32-byte random Bearer token** on a trusted device, encode it as 43 unpadded base64url characters, and compute its **SHA-256 hex digest over those 43 ASCII characters**. Keep the raw token only in the external producer's secret store; place **only the hex digest** in the Draft. Do not reuse `MCP_ACCESS_TOKEN`. No new Worker Secret, D1 migration, server or scheduler is needed.

```json
{
  "version": 1,
  "name": "Webhook notification",
  "inputs": {"payload": null},
  "triggers": [{"type": "webhook", "token_sha256": "<64 lowercase SHA-256 hex characters>"}],
  "steps": [{"id": "emit", "uses": "result.emit", "with": {"data": {"ref": "inputs.payload"}}}]
}
```

After owner validation and explicit Publish, POST to `https://workflow.lirtual.dpdns.org/triggers/webhook/{workflow_id}` with `Authorization: Bearer <43-character-token>`, `Content-Type: application/json`, and a JSON object containing **only declared Workflow input names** (up to 8 KiB). Optionally provide `X-Workflow-Event-Id: <stable-event-id>` (1–96 safe characters). The server hashes that ID into the existing D1 admission key, so a duplicate ID and identical inputs resolve to one logical Run; changed inputs conflict. **Without a stable ID, each delivery is independent** and no exactly-once behavior is implied. A valid request returns `202` with the queued Run identity or `200` on an already admitted replay. Check `workflow_status`/`workflow_result` for execution outcomes; receipt acceptance is not Action success. The token hash is pinned to the active published version; pause blocks admission and republishing a different hash revokes the previous credential. Old event IDs do not silently execute under a new version.

Ingress returns 401 for an invalid token, 400/413/415/422 for malformed or oversized requests, 409 for paused/version/idempotency conflicts, and 429 for exhausted Run quota. Request bodies and token values must not appear in logs. Bearer authentication assumes HTTPS transport and a securely random 256-bit token; it does **not** verify a source IP or cryptographic payload signature beyond TLS and the secret. Do not put provider secrets directly into a Workflow definition or emit them as results.

## GitHub push events (signed OIDC relay)

For native GitHub push events, use GitHub Actions **only as a one-step authenticated event sender**; Cloudflare Workflows remains the only business orchestrator. The GitHub OIDC JWT cryptographically attests the repository identity, event type, branch, forwarding workflow file, commit SHA and Actions Run identity. Unlike GitHub's direct repository Webhooks, the OIDC relay needs **no new Worker Secret and no per-repository HMAC credential**. GitHub's direct Webhooks remain unsupported by this endpoint.

Create a Draft with an exact repository and its immutable numeric repository ID, a branch and an existing event-forwarding workflow path:

```json
{
  "version": 1,
  "name": "GitHub push event",
  "inputs": {"github": null},
  "triggers": [{
    "type": "github_event",
    "repository": "example/repo",
    "repository_id": 12345,
    "event": "push",
    "ref": "refs/heads/main",
    "workflow_path": ".github/workflows/forward.yml"
  }],
  "steps": [{"id": "emit", "uses": "result.emit", "with": {"data": {"ref": "inputs.github"}}}]
}
```

The owner must explicitly validate and Publish this Plan. The matching source repository must separately install exactly the pinned `.github/workflows/forward.yml` event-forwarding job. Example (adapt to the real repository, exact branch, Workflow ID and nonsecret audience):

```yaml
name: Forward GitHub push to Workflow MCP
on:
  push:
    branches: [main]
permissions:
  contents: read
  id-token: write
jobs:
  forward:
    runs-on: ubuntu-latest
    steps:
      - name: Send GitHub-signed event identity
        env:
          TARGET_WORKFLOW_ID: ${{ vars.WORKFLOW_EVENT_WORKFLOW_ID }}
          OIDC_AUDIENCE: ${{ vars.WORKFLOW_GITHUB_OIDC_AUDIENCE }}
        shell: bash
        run: |
          set -euo pipefail
          test -n "$TARGET_WORKFLOW_ID"
          test -n "$OIDC_AUDIENCE"
          jwt="$(curl -fsS -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
            "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${OIDC_AUDIENCE}" | jq -er .value)"
          curl --fail-with-body --silent --show-error --retry 2 \
            -X POST "https://workflow.lirtual.dpdns.org/triggers/github/${TARGET_WORKFLOW_ID}" \
            -H "Authorization: Bearer $jwt"
```

`WORKFLOW_EVENT_WORKFLOW_ID` must match the real Published Workflow UUID; `WORKFLOW_GITHUB_OIDC_AUDIENCE` must equal the **existing** Worker `GITHUB_ACTION_OIDC_AUDIENCE` value (it is not a Secret). No new Cloudflare binding is needed. The forwarding workflow must run directly on the pinned branch with `on: push` and `id-token: write`. The event endpoint accepts a **bodyless POST**; unlike the generic Webhook, it does not accept caller-controlled JSON or custom event IDs.

An authorized delivery normalizes `inputs.github` from **signed JWT claims only**: repository name and ID, `event: push`, ref, SHA and stable Actions `run_id`. Duplicate deliveries and manual GitHub Actions reruns use the same D1 admission key and return the existing Run; different Actions runs produce separate admissions. The usual active Published Version, pause, Run capacity and immutable Action grants still apply. A successful HTTP 202 means accepted, **not** business completion; inspect Workflow MCP Status/Result. A newly published Version with different source pins immediately rejects older signed senders. GitHub Actions Event Bridge jobs are not automatic GitHub webhook subscriptions; the owner controls their creation/removal in each source repository, and no missed-event backfill is promised.

## Release and verification

Use `.github/workflows/release.yml` (GitHub Actions → Release Worker) on `main`, selecting `worker=workflow-mcp-worker` and `deploy_to_production=true`. There are no per-capability enable inputs. The release verifies the selected GitHub Environment secrets, fixed Portal/executor identity, D1 schema, active Runs and the exact deployed Worker version.

GitHub Actions are dispatched only through the explicitly approved `github.action` Task/Session contract; there is no dedicated fixed CI executor.

The regular test contract is `pnpm --filter workflow-mcp-worker check` (TypeScript, unit/contract suite, Wrangler dry-run). Production smoke tests are explicitly selected through `.github/workflows/acceptance.yml` and are separate from deployment; Portal registration requires a separate `confirm_portal_write` acknowledgment. A passing dry-run does not establish production acceptance.

Old schema migration filenames are retained because they have already been recorded by D1. They are historical database identifiers, not product stages.
