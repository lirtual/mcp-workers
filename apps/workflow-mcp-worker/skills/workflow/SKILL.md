---
name: workflow
description: Operate the lirtual/mcp-workers Workflow MCP plugin to inspect, author, validate, publish, run, pause, cancel, or diagnose durable Workflows and Actions. For @Workflow tasks, not GitHub CI or other Workflow SDKs.
---

# Workflow MCP operator

This Skill documents static routing and DSL usage, not live contracts, credentials, permissions, or publication state. The MCP compiler, immutable Published Plan, Action source manifests, and live discovery remain authoritative. Do not request a capabilities overview before routine calls.

## Select the shortest safe route

| Intent | Tool route |
| --- | --- |
| Run an existing Published Workflow with a known ID and known inputs | `workflow_run` → `workflow_result`; only use `workflow_status` when unsettled |
| Unknown Workflow ID | `workflow_list` → choose exact ID |
| Unknown Published input contract | `workflow_get` → `published_run_interface`; never infer from editable Draft |
| Inspect a particular Workflow | `workflow_get` |
| Author or edit | This Skill → discovery only for external Actions → `workflow_validate({definition})` → `workflow_create` or `workflow_update` |
| Publish | `workflow_get` → `workflow_validate` → explicit target-risk permission → `workflow_publish` |
| Diagnose or cancel | `workflow_result` / `workflow_status` → `workflow_cancel` if explicitly required |
| Pause, resume, or delete | Read current state, then the matching named tool only with authorization |

Use `workflow_action_list({})` only to choose source-reviewed GitHub/Cloudflare `action.run` candidates. For an `mcp.call`, explicitly call `workflow_action_list({source:"portal"})` to obtain the separately scoped reviewed Portal tool, actual input/output schema, example arguments, and `schema_digest`. Absence of a read tool does **not** prove a write tool is approved or unavailable: inspect the separate scope statuses. `workflow_connection_status` checks connection generation; a discovered candidate never grants Publish or runtime access. Do not use arbitrary Portal URLs, tools or unreviewed writes.

## Draft language quick reference

A definition is YAML/JSON with `version: 1`, `name`, optional `inputs` and `triggers`, and bounded `steps`. For a simple manual workflow, a single result emitter is enough:

```json
{"version":1,"name":"Echo","inputs":{"message":"hello"},"steps":[{"id":"out","uses":"result.emit","with":{"data":{"ref":"inputs.message"}}}]}
```

Each Step needs a stable `id`. `needs` declares dependencies, `if` conditions are compiler-supported structured expressions (not executable scripts), and `{ "ref": "inputs.message" }` references a runtime value. Supported step families include `result.emit`, reviewed `mcp.call`, reviewed GitHub/Cloudflare `action.run`, limited `http.request`, and bounded `flow` operations (`repeat`, `foreach`, `until`, child, wait, wait_event). Cron uses a five-field UTC schedule; Webhook needs its independent bearer token; signed GitHub push relay is not a general webhook. Nested arbitrary loops, unapproved external writes and arbitrary commands are not supported. `workflow_validate` is authoritative for supported shapes, limits and error paths.

For an external `mcp.call`, copy the actual `endpoint`, `tool`, `scope`, `input_schema` and optional `output_schema` from Portal discovery; the compiler and Publish check the exact schema digest. Use `workflow_validate({definition})` **before** creating a Draft; fix every structured issue. Inline Validate never writes D1, publishes or dispatches. Update an existing Draft with its latest `expected_revision`. Publishing freezes an immutable Plan and effect grants; no discovered Action, test result, or account authentication replaces a fresh Owner approval of the actual target and risks. Publication of Cron, Webhook or GitHub event triggers can admit future effects.

## Execute and recover

Use a stable `idempotency_key` for effectful runs. If the request was based on `workflow_get` and a changed Published Version would matter, pass the independent `expected_published_version_id` assertion to `workflow_run`. Do not confuse it with the internal trigger version parameter. Without the assertion, ordinary runs use the current Published Plan.

EnvShare: `inputs.text` accepts 1–16384 UTF-8 bytes; `ttl_seconds` defaults to 86400 (60–604800), `max_reads` defaults to 1 (1–10). Its `idempotency_key` is required. Preserve the initial one-time `delivery_key` privately and give it to `workflow_result` after success to obtain the share URL. It cannot be recovered from D1. Litterbox: public plaintext upload needs fresh explicit Owner approval, a top-level selected `file`, optional `inputs.time` (1h/12h/24h/72h, default 24h), a manual single-step eligible Published Plan and mandatory idempotency key. Never treat a URL in JSON as a selected file. Session `duration_minutes` (1–300, default 300) is overridable only where `published_run_interface` confirms an explicit Published binding.

A queued Run ID is not completion. Read `workflow_result` for business outcomes, then `workflow_status` when still unsettled. These reads may reconcile an admitted Run. Never replay an Unknown/indeterminate external effect, failed upload, unconfirmed GitHub Attempt or one-time key. `workflow_pause` blocks **new** admissions, not active effects; cancellation acknowledgments do not prove physical termination. Connection revoke/enable changes generations and requires affected Plan republish. `workflow_delete` tombstones a safe Draft/paused Workflow, not its historical receipts. Report Draft, Published Version, Run/Step and physical outcome separately, marking unverified checks explicitly.
