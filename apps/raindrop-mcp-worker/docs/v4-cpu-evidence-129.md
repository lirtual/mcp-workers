# v4 T02 — production native CPU evidence path

Issue [#129](https://github.com/lirtual/mcp-workers/issues/129) implements the owner-amended production evidence harness. It does not claim that a v4 tracer is deployed or that the Free-plan CPU gate passes. The harness intentionally returns **Blocked** until the `diagnostics_read` and `raindrop_read` tracers exist.

## Safety and provenance contract

The `Raindrop v4 Native CPU Evidence` workflow is `workflow_dispatch` only and has `contents: read` permission. A run must provide a full immutable source SHA, type the exact production script name `raindrop-mcp-worker`, and supply the deployment/version expected to be active before the run. The requested SHA must equal the workflow-dispatch revision (`github.sha`), making the selected reviewed workflow revision the deploy authorization instead of accepting an arbitrary repository commit. The checkout must match that SHA and tracked files are rechecked immediately before deployment, after installation and tests.

Immediately before deployment, the harness reads Cloudflare's deployment API and requires one version at 100%. It records that deployment and version as the rollback point and refuses a stale or ambiguous target. Deployment uses the fixed Wrangler config, exact script name, `--keep-vars`, and no secrets file or secret-changing command. The existing production `MCP_ACCESS_TOKEN` and `RAINDROP_ACCESS_TOKEN` bindings are preserved. After deployment, the harness requires new deployment/version IDs and verifies that the active Cloudflare deployment annotation contains the exact source SHA.

If any post-deploy provenance, probe, telemetry, or artifact step fails or is cancelled, the workflow uses Cloudflare's deployment API to restore the recorded version at 100% traffic and verifies the returned deployment. A separate dependent cleanup job repeats the same guarded rollback when the evidence job fails, is cancelled, or reaches its job timeout, so cleanup does not depend on later steps in the timed-out job executing. Rollback is compare-and-set: it is a no-op if the old version is already active, restores only an active deployment carrying this run's exact source annotation, and refuses to overwrite a newer unrelated deployment. This also handles a lost Wrangler response after Cloudflare accepted the deployment. The pre-deploy snapshot intentionally does not compare the old deployment against the future source SHA; only the post-deploy snapshot performs that exact provenance check. Deployment-command ambiguity, post-deploy provenance failures, probe/collection failures, and rollback failures produce sanitized structured evidence without response content or credentials.

This workflow deploys only after an explicit manual dispatch and any protection applied to the `workflow-mcp-worker` environment. It is never triggered by a push, pull request, schedule, or workflow completion. Running it requires the existing `CLOUDFLARE_API_TOKEN` and a separately configured `RAINDROP_PRODUCTION_MCP_ACCESS_TOKEN`; neither is written to an artifact or rotated by the workflow.

## Fixed read-only observations

There are exactly four MCP operations:

| Evidence label | JSON-RPC request | Business effect |
| --- | --- | --- |
| `initialize` | `initialize` | local protocol handshake |
| `tools_list` | `tools/list` | local tool discovery |
| `diagnostics_read_local` | `tools/call diagnostics_read {action:"local"}` | local diagnostics, no upstream request |
| `raindrop_read_list_1` | `tools/call raindrop_read {action:"list",collectionId:0,page:0,perpage:1}` | one bounded upstream read |

The driver contains no mutation selector and accepts operation objects only by identity from its frozen allowlist. It makes one first observation and then three windows of ten observations per operation (31 per operation, 124 total). Every request is submitted once with redirects disabled; there is no MCP retry path. In particular, there is no write request and no mechanism that could retry one.

Each request carries only sanitized correlation headers: `x-raindrop-evidence-run`, `x-raindrop-evidence-op`, and `x-raindrop-evidence-sample`. Values are restricted to lowercase letters, digits, `.`, `_`, and `-`, with a maximum of 64 characters. Response bodies, account content, URLs, session identifiers, and credentials are never logged or retained. The journal keeps only operation/sample labels, UTC boundaries, HTTP status, and JSON-RPC success.

## Native telemetry gate

After all observations, the collector performs a bounded run-level query (at most six attempts while waiting for ingestion):

`POST /accounts/{account_id}/workers/observability/telemetry/query`

The query filters the `cloudflare-workers` dataset by the exact script, deployed version, run, and existence of native `$workers.cpuTimeMs`; the collector then correlates every operation/sample header locally. Its event limit is 200 for the fixed 124-observation plan (the current Cloudflare schema allows up to 2000). It requires exactly one event per journal entry, a finite non-negative native CPU value, UTC event time, HTTP 200 matching the successful journal, and successful JSON-RPC status. A missing field, zero or multiple matching events, mismatched version/header/status, failed request, incomplete 124-sample journal, or incomplete query produces a sanitized `status: "blocked"` evidence artifact and a nonzero exit. Wall time, query elapsed time, and `$metadata.duration` are never accepted as CPU substitutes.

The final sanitized JSON artifact records source SHA, target deployment/version, rollback deployment/version, and the 124 per-request native CPU/status observations. A completed artifact is measurement evidence only; #129's acceptance decision must still evaluate every fixed operation against the spec's CPU threshold. The workflow does not invoke Portal, make Raindrop mutations, or implement the #130 tracer.

## Local verification

Run the guard/parser suite with:

```bash
pnpm --filter raindrop-mcp-worker run test:cpu-evidence
```

It is also included in the package `check` command. The tests exercise the immutable SHA and target guards, exact sample plan, single-active-version rule, provenance annotation, exact telemetry filters, native CPU/UTC/status parsing, ambiguity failures, fixed-operation identity allowlist, and the expected block against the current pre-tracer tool surface.
