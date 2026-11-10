---
name: workflow
description: Operate the lirtual/mcp-workers Workflow MCP plugin: inspect, author, validate, publish, run, pause, cancel, or diagnose its durable Workflows and Actions. Use for @Workflow orchestration tasks, not ordinary GitHub Actions CI definitions or Vercel Workflow SDK.
---

# Workflow MCP operator

Use the existing **Workflow** MCP tools for execution. This skill is an operator guide, not a source of capabilities, contracts, credentials, or additional authorization.

## Route the request

| Intent | Starting tools | Done when |
| --- | --- | --- |
| Inspect existing workflows | `workflow_list` → `workflow_get` | The requested Draft/Published state and limits are verified |
| Author or change a workflow | `workflow_capabilities` → `workflow_validate` → `workflow_create` or `workflow_update` | A validated Draft at the intended revision exists; publication is a separate step |
| Publish a reviewed Draft | `workflow_get` → `workflow_validate` → `workflow_publish` | The intended immutable Published Version is confirmed |
| Execute an existing workflow | `workflow_get` → `workflow_run` → `workflow_status` / `workflow_result` | The actual Run outcome, not just admission, is established |
| Diagnose, pause, or cancel | `workflow_status` / `workflow_result`; `workflow_pause` or `workflow_cancel` only as needed | Admission state and external effects are reported separately |

For deletion, use `workflow_get`, check active Runs and published references, then use `workflow_delete` only with the user's explicit scope and revision. Deletion tombstones the Workflow; it does not erase historical receipts. Resume new admissions with `workflow_resume` only when requested.

## Discover and draft

1. Call `workflow_capabilities` without an ID only when exploring available capabilities. When a capability is known, query its specific `id` for a smaller compiler-aligned schema, constraints, and example. Use `workflow_action_list` to discover current source-reviewed GitHub Task/Session candidates from the single release-pinned executor (`refs/heads/main`); Publish requires explicit approval, and dispatch rechecks exact main SHA and successful push CI. Read connection state through `workflow_connection_status` when an external action needs it.
2. Select currently supported capabilities and build the smallest definition. Use exact schema and action fields returned by the tools, not remembered examples or guessed values. A configured connection, discovered contract, compiler-valid definition, and publishable action are **different states**.
3. Validate the YAML/JSON definition inline with `workflow_validate({definition})` **before** creating a Draft. Inspect every `issues[].code` and `path`; fix the definition and validate again. Inline validation does not create, publish, or dispatch.
4. On user-authorized creation, call `workflow_create`. For edits, get the current Draft first and pass `expected_revision` to `workflow_update`. Validate the saved Draft with its `workflow_id` and revision before considering publication.

Minimal inline-only definition (compile/validate, no external effect):

```json
{
  "version": 1,
  "name": "Echo",
  "inputs": {"message": "hello"},
  "steps": [
    {"id": "out", "uses": "result.emit", "with": {"data": {"ref": "inputs.message"}}}
  ]
}
```

For Cron use the current five-field UTC rules; for Webhook or GitHub push relay use the corresponding discovery result. Expressions, `needs`, branches, loops, and nested behavior must match the compiler, not general-purpose YAML or GitHub Actions syntax.

## Publish and execute

1. Read the saved Draft, exact expected revision, and latest `workflow_validate` output. Take required operation scopes, schema digests, pinned Action identity, child version/digest, Cloudflare deployment identity, and HTTP URL/method **from live discovery and validation**. Never fabricate these grants or assume yesterday's versions remain current.
2. Classify real effects (MCP writes, HTTP requests, GitHub execution, Cloudflare providers, public uploads, compensation). Obtain the user's explicit authorization for the actual target, impact, and risks before setting `workflow_publish` approval assertions. Authenticated approval fields are not proof that a human reviewed the operation.
3. Publish the exact reviewed Draft only after all runtime grants and external prerequisites are met. Confirm the returned Published Version. Publishing is not running; a published Cron/Webhook/GitHub trigger can admit future Runs, so review trigger effects before publication.
4. Run only an authorized Published Workflow. Use a stable `idempotency_key` for effectful manual admissions when applicable. An ordinary `workflow_run` may return a Run ID before completion: inspect `workflow_status` and `workflow_result` to determine outcome. These reads may reconcile already-admitted Runs.
5. For EnvShare, preserve a one-time `delivery_key` from the initial response for the matching result request; do not log or guess it. Public Litterbox plaintext file disclosure requires fresh, explicit owner instruction and a separately approved eligible plan. Read sensitive Session credentials only on an explicit user request via the dedicated sensitive-data tool.

## Stop, recover, and report

- `workflow_pause` blocks **new** admissions, not active Runs. `workflow_cancel` requests cancellation for a supported Run/Step; acknowledgments and native child termination do not prove remote Session or other external effects ended. Force cancellation has separate prerequisites and can bypass cleanup.
- Treat `unknown`, `indeterminate`, pending receipts, and transport timeouts as unresolved effects. Reconcile exact Run/Step and external terminal evidence before any new attempt; never blindly replay an effectful action or public upload.
- `workflow_approval` is a one-use decision for an already waiting, version-pinned GitHub gate. Check exact Run/Step/Version and explicit user authorization; an approval wake is not GitHub success.
- Revoking/enabling a Portal or HTTP connection changes its generation. Require explicit authorization; verify the fence and republish affected plans when re-enabled rather than replaying unknown work.
- Report separately: Draft validity, Published Version, Run admission, Step state, external physical outcome, and anything unknown. Finish when evidence supports the requested goal; mark unperformed real-world checks as unverified.
