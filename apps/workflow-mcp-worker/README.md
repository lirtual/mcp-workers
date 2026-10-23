# Workflow MCP Worker

Versioned, durable workflows using the existing MCP Portal, Cloudflare D1 and Cloudflare Workflows. One Worker exposes a unified set of capabilities; no separate execution stages, capability enable switches, scheduler, queue or credential issuer.

## Capabilities

- **Workflow management:** create and revise YAML/JSON Drafts, validate a bounded DAG, explicitly Publish an immutable Plan, run asynchronously, inspect status/results, pause/resume new admissions.
- **MCP tool calls (`mcp.call`):** read-only operations routed through the existing, server-pinned MCP Portal. Publish requires the exact endpoint, tool, `read` scope and schema digest, plus `accept_target_risks: true`. Runtime checks revalidate the published grant and live tool schema. The remote `readOnlyHint` is untrusted: network isolation and absence of remote side effects are not guaranteed.
- **GitHub Actions (`github.run`):** a single server-registered `github.workflow.check` operation that runs the pinned Workflow package CI checks, with explicit `approve_heavy_execution: true` at Publish. Repository, workflow, ref and GitHub OIDC audience are pinned server-side. D1 records dispatch identity, GitHub OIDC Claim and immutable callback receipt; ambiguous external effects are never blindly replayed.
- **Result emission (`result.emit`)** for Workflow results.

Only these known operations are implemented; generic shell commands, arbitrary external MCP writes, dynamic GitHub tasks, artifacts and automatic GitHub Job cancellation are not provided. Cron is a five-field UTC schedule matched on this Worker's one-minute scheduled event, not a separate cron per workflow. Webhook and GitHub event triggers share the same Run admission.

## Runtime

The owner-facing endpoint is `https://workflow.lirtual.dpdns.org/mcp`. The existing production Portal endpoint is `https://mcp.lirtual.dpdns.org/mcp`. The Worker's MCP endpoint requires the existing Portal bearer authentication; GitHub callbacks use GitHub-issued OIDC, not the Portal bearer.

The immutable Run Plan and status are stored in D1; Cloudflare Workflows advances the bounded DAG. Every Run is pinned to its Published Version. The target URL, tool and schema are never dynamically determined by arbitrary client inputs. External dispatch and callback state use persisted attempt IDs and verified physical GitHub Job identity.

Environment bindings and credentials:

- `DB` and `WORKFLOW` (`workflow-mcp-runner`).
- `MCP_ACCESS_TOKEN` for owner API ingress.
- `MCP_PORTAL_CLIENT_ID` / `MCP_PORTAL_CLIENT_SECRET` for the pinned Portal.
- `WORKFLOW_EXECUTOR_GITHUB_TOKEN` for the registered GitHub executor.
- Release-pinned non-secret variables `MCP_PORTAL_ENDPOINT`, `GITHUB_EXECUTOR_REPOSITORY`, `GITHUB_EXECUTOR_REPOSITORY_ID`, `GITHUB_EXECUTOR_REF` and `GITHUB_EXECUTOR_AUDIENCE`.

There are **no independent capability enable flags**. The documented per-operation Publish approvals and runtime authorization checks remain mandatory.

## MCP owner tools

`workflow_list`, `workflow_get`, `workflow_create`, `workflow_update`, `workflow_validate`, `workflow_publish`, `workflow_run`, `workflow_status`, `workflow_result`, `workflow_pause` and `workflow_resume`.

Publishing is explicit; saving a Draft never starts execution. `workflow_pause` prevents new admissions but does not stop an active Run or automatically cancel an external Job.

## Release and verification

Use the existing `.github/workflows/ci.yml` release workflow on `main`, selecting `worker=workflow-mcp-worker` and `deploy_to_production=true`. There are no per-capability enable inputs. The release verifies the selected GitHub Environment secrets, fixed Portal/executor identity, D1 schema, active Runs and the exact deployed Worker version.

The registered GitHub job is `.github/workflows/workflow-github-executor.yml`. It only runs the fixed Workflow package CI check; it accepts no user-provided shell, repository or ref.

The regular test contract is `pnpm --filter workflow-mcp-worker check` (TypeScript, unit/contract suite, Wrangler dry-run). Production smoke tests are explicit, disposable and separate from deployment. A passing dry-run does not establish production acceptance.

Old schema migration filenames are retained because they have already been recorded by D1. They are historical database identifiers, not product stages.
