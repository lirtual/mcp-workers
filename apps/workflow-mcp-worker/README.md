# Workflow MCP Worker

Versioned, durable workflows using the existing MCP Portal, Cloudflare D1 and Cloudflare Workflows. One Worker exposes a unified set of capabilities; no separate execution stages, capability enable switches, scheduler, queue or credential issuer.

## Capabilities

- **Workflow management:** create and revise YAML/JSON Drafts, validate a bounded DAG, explicitly Publish an immutable Plan, run asynchronously (manually, via a published UTC Cron schedule, an authenticated Webhook, or a signed GitHub push relay), inspect status/results, pause/resume new admissions, and non-destructive Workflow deletion.
- **MCP tool calls (`mcp.call`):** the existing read-only operations plus two source-reviewed write operations, IMA `ima_create_note` and `ima_append_note`. Both require the exact pinned Portal endpoint, tool, scope and schema digest plus `accept_target_risks: true`; write additionally requires `approve_mcp_write_execution: true`. Reviewed writes accept at most one top-level Step per Plan: create with literal `content` (1–2048 chars), or append with a literal existing numeric `note_id` (8–24 digits) and literal `content` (1–2048 chars). No folder, dynamic input or Foreach writes. Runtime verifies the live schema and explicitly reviewed tool before a single D1 dispatch reservation. Upstream `readOnlyHint` never authorizes a write; an unknown call result remains `indeterminate` without an automatic resend.
- **HTTP Action (`http.request`):** one literal, canonical public HTTPS URL and GET/HEAD/POST operation approved verbatim at Publish. No dynamic URL, query, credentials, caller headers or redirect following. A durable D1 fence prevents blind retries, and the independently revocable HTTP Connection prevents older Plans being revived.
- **GitHub Actions (`github.run`):** explicitly reviewed, repository-scoped `github.action` Task/Session definitions. A new compatible Action can be discovered from an already approved repository without redeploying the Worker. Publish still requires the exact reviewed SHA, tag, workflow, input contract and `approve_heavy_execution: true`; automatic discovery grants no execution. Task success follows the verified native GitHub terminal, not dispatch ACK or callback receipt. Optional signed Task JSON output (up to 4 KiB) is reported only after that native success. A Session completes its startup step at verified Ready, while the physical GitHub Run and cancellation/quota remain separate.
- **Result emission (`result.emit`)** for Workflow results.

No arbitrary shell input or unreviewed repository dispatch is allowed. Workflow cancellation of approved GitHub Actions is separate from stopping admission; native GitHub Run state is reconciled before a physical termination is declared.


### Unified Action syntax (Spec #392)

New GitHub Task/Session Drafts can use `action.run` with `with.executor: github` and
all existing `github.action` identity fields and explicit Publish grants. The
compiler deliberately normalizes this to the **unchanged internal** GitHub
execution shape; the old `github.run` Published Plan, digest, OIDC, Attempt,
Ready and physical Session lifecycle remain unchanged. The new spelling does
**not** grant execution or make a discovered Action runnable automatically.

The `workflow_publish.approved_cloudflare_actions` MCP input uses bounded
provider/action identifier strings, not a fixed client-side enum. This is
**not** dynamic Provider registration: Validate/Publish/Run still require a
source-reviewed Action, exact manifest digest, configured Service Binding
identity, deployment ID and explicit approval. Previously cached MCP tool
metadata may require a one-time client refresh.

Cloudflare `action.run` supports generic Owner-only `weixin.send_text` v3
(`input: {text}` with an optional verified `session_step_id` to append the
signed OpenList URL), the legacy `weixin.notify_download` v1 for currently
published Plans, and `bark.send_notification`. A notification that follows
another Step requires `needs`; the executor verifies persisted predecessor
success before sending, so caller-supplied success cannot authorize a send.
Publish requires separate explicit grants, the exact contract digest and
Worker Version ID; the Service Binding must independently confirm live identity.
D1 grants a single first-dispatch right. Weixin can recover by historical
receipts; Bark preserves unknown outcomes without a second send. No public
Weixin MCP write is used.
The production Provider and Workflow are deployed independently. A signed OpenList Ready URL at the exact Quick Tunnel root may arrive with or without a trailing slash; Workflow normalizes only this equivalent root URL before hashing and invoking the Provider, while keeping the original signed D1 value for its dispatch fence. Arbitrary paths, query strings, credentials, redirects and other domains remain forbidden.

### Bounded while / until (Spec #176)

A `flow: while` or `flow: until` Step has a literal `max_iterations` (1–8),
a safe Boolean `condition`, optional `needs`, and exactly one template:
pure `result.emit` with `data`, or reviewed `mcp.call` with `scope: read`,
exact Portal endpoint/tool/input schema and `arguments`. The only extra
references are `item.index` (zero-based) and `item.value` (initially null,
then the previous result); safe input and declared dependency references
remain available. While checks the condition *before* each iteration; until
checks *after* the current result. Early exit returns `{iterations, value}`;
exhaustion fails with `loop_budget_exceeded`, never silent success.

For MCP bodies, Publish requires the existing exact `approved_operations`
and `accept_target_risks`; the Portal's current generation is pinned to
the immutable Plan. Per-iteration effective arguments are frozen in a native
checkpoint **before** dispatch, followed by a D1 one-shot child fence and
the existing Portal reservation. A revoked connection, failed child or
uncertain external result halts further iterations; replay never blindly
repeats a remote `tools/call`. These are tool-advertised *read-only* calls,
not a claim that external systems are intrinsically side-effect-free.

Every possible iteration counts toward the existing 32-step Plan budget.
Each decision and iteration has a stable native checkpoint. No new D1 table,
Worker, queue or scheduler is introduced. Nested loops, multiple body
Actions, write-scope MCP, HTTP, GitHub and Cloudflare Action bodies and
dynamic iteration limits remain unsupported.

### Optional runtime approval before GitHub dispatch (Spec #176)

A top-level, reviewed `github.run` or `action.run` with `executor: github`
may additionally declare `"approval":{"required":true}`. Only **one** runtime
gate is supported per Plan; approval is rejected for read-only MCP calls,
Cloudflare notifications, foreach/repeat templates and unsupported operations.
Publish still requires all existing immutable source/contract grants and
`approve_heavy_execution: true`. Omitting `approval` retains existing behavior.

On Run, `workflow_status` reports the Step as `waiting_approval` for up to
**10 minutes**. The owner must explicitly call `workflow_approval` with the
**exact `run_id`, `step_id` and `published_version_id`**, and `decision` of
`approve` or `deny`. Only that matching one-use decision can unlock the
reviewed GitHub dispatch. Denial/timeout/mismatch/repeated decisions block
or reject; the Run does **not** automatically approve or resend unknown
GitHub operations. A best-effort native wake is not business success; D1 is
the durable decision and the existing GitHub Attempt/OIDC ledger still
controls physical dispatch and result. The gate is an authenticated **MCP
API assertion**, not independently verified presence of a human, and it
cannot expand existing execution permissions. `workflow_cancel` may cancel
a waiting gate or an already-approved Step before its first durable GitHub
Attempt, provided no other Step is active. The D1 Run cancellation and Attempt
insert race atomically: cancellation first forbids GitHub dispatch. If the
Attempt was inserted but its physical GitHub Run ID is still unconfirmed,
cancellation durably closes the business Run, denying any subsequent signed
physical Claim while retaining an unverified external-dispatch outcome. An
already confirmed physical Run instead uses existing GitHub cancellation and
terminal reconciliation. An approval decision, even if consumed, is not itself
an external Attempt. Force cancellation requires an existing Attempt and the
normal physical safeguards. Cancellation is a request, not proof of physical
termination. A paused Workflow blocks new Runs; it does not reverse an
in-flight approved operation.

The additional D1 migration `0015_runtime_approval.sql` is applied only by
the existing selected-Worker GitHub Actions release path, after read-only
quiescence checks. Existing Published Versions retain their original
behavior; the new gate is strictly opt-in.

### Session Action launch-time duration (1–300 minutes)

All reviewed GitHub **Session** Actions (ubuntu, windows, chrome, code-server,
openlist) may opt into a single numeric Run override without weakening the
immutable Action review and Publish grants. The reviewed GitHub Action still
has to declare `duration_minutes` (default 300) and `duration_mode`
(`explicit`). A new or one-time migrated Workflow Draft declares:

```json
{
  "version": 1,
  "name": "example session",
  "inputs": {"duration_minutes": 300},
  "steps": [{
    "id": "session",
    "uses": "action.run",
    "with": {
      "executor": "github",
      "capability": "github.action",
      "action": {
        "repository": "<reviewed repository>",
        "repositoryId": 123,
        "workflowId": 456,
        "workflowPath": ".github/workflows/ubuntu.yml",
        "commitSha": "<exact reviewed 40-character SHA>",
        "type": "session",
        "contractDigest": "<exact reviewed 64-character digest>",
        "ref": "refs/tags/<immutable reviewed release tag>",
        "inputs": {
          "duration_minutes": {"ref": "inputs.duration_minutes"},
          "duration_mode": "explicit",
          "session_mode": "fixed"
        }
      }
    }
  }]
}
```

The identifiers above are illustrative, not publishable values. Use
`workflow_action_list` to obtain **all** the real, exact reviewed fields and
retain the existing Publish approvals (and any downstream notifications).

After this one-time Publish, `workflow_run({workflow_id})` defaults to **300**
minutes; `workflow_run({workflow_id,inputs:{duration_minutes:10}})` runs for
**10** minutes without republishing. Only whole-number minutes **1–300** are
accepted. `0`, `301`, decimals and numeric strings fail before Run admission.
The Run snapshots the selected duration in D1; Session dispatch and one-shot
Attempt registration independently re-evaluate the same persisted input.
The Runner enforces the deadline from its earliest job-start timestamp and
cleans up normally. No Task Action or other GitHub dispatch input is dynamically
bound; the exact Action source, tag, contract, secrets and approval remain pinned.

Already published literal-input Session plans keep their existing behavior:
they do **not** accept duration overrides until separately republished with
the opt-in binding. Older `duration_mode: repository` plans retain their
repository-variable behavior; there is no silent conversion to the new mode.
Changing Action sources or the live Worker still requires the normal,
separately authorized release process.

## Runtime

The owner-facing endpoint is `https://workflow.lirtual.dpdns.org/mcp`. The existing production Portal endpoint is `https://mcp.lirtual.dpdns.org/mcp`. The Worker's MCP endpoint requires the existing Portal bearer authentication; GitHub callbacks use GitHub-issued OIDC, not the Portal bearer. External Webhooks require a distinct, scoped random Bearer token; never send the MCP owner credential to a Webhook producer.

The immutable Run Plan and status are stored in D1; Cloudflare Workflows advances the bounded DAG. Every Run is pinned to its Published Version. The target URL, tool and schema are never dynamically determined by arbitrary client inputs. External dispatch and callback state use persisted attempt IDs and verified physical GitHub Job identity.

Environment bindings and credentials:

- `DB` (`workflow-mcp-db`) and `WORKFLOW` (`workflow-mcp-orchestrator`).
- `MCP_ACCESS_TOKEN` for owner API ingress.
- `MCP_PORTAL_CLIENT_ID` / `MCP_PORTAL_CLIENT_SECRET` for the pinned Portal.
- `WORKFLOW_GITHUB_DISPATCH_TOKEN` for the registered GitHub executor.
- `SESSION_RUNTIME_DATA_KEY` as a canonical Base64-encoded 32-byte random AES-GCM key, staged as a GitHub Environment Secret for `workflow-mcp-worker`. Key replacement intentionally invalidates previously stored ciphertext; active Runner observations must refresh it.
- Release-pinned non-secret variables `MCP_PORTAL_ENDPOINT`, `GITHUB_EXECUTOR_REPOSITORY`, `GITHUB_EXECUTOR_REPOSITORY_ID`, `GITHUB_EXECUTOR_REF` and `GITHUB_EXECUTOR_AUDIENCE`.
- `GITHUB_ACTION_APPROVED_REPOSITORIES` is a server-owned JSON list of `{repository,repositoryId}` identities. A previous `commitSha` entry is tolerated but ignored for discovery. The current default-branch SHA is read from GitHub and every YAML is fetched by that exact SHA; approval of any discovered revision remains bound to the immutable Published Plan. Changing the approved repository list still requires a controlled configuration deployment.

There are **no independent capability enable flags**. The documented per-operation Publish approvals and runtime authorization checks remain mandatory.

### Bounded public HTTP Action and live revocation (Spec #176)

A Draft Step may use `uses: http.request` with literal `with.url` and
`with.method` (`GET`, `HEAD`, `POST`). `POST` alone may provide
`with.body` as immutable JSON (up to 4 KiB); runtime references in the body are not supported in this first slice. The URL must be a
canonical public HTTPS hostname and path (standard port only), without
query, fragment, credentials or URL-encoded path. Private/IP-literal and
special-use hostnames are rejected before Publish and again at runtime.
No user-supplied headers, managed upstream credentials, automatic redirects,
or dynamic URL/method expressions are accepted.

`workflow_validate` returns `required_http_operations`. The owner must
Publish the exact array as `approved_http_operations`, plus
`approve_http_execution: true` and `accept_target_risks: true`.
There is **no** implicit permission from the Draft or discovered capability.
`workflow_connection_status/revoke/enable` accept optional `target: http`;
omitting it retains the original Portal behavior. HTTP has its own D1
`http_connection_auth` generation (migration 0017). Revoke serializes
against the first HTTP effect reservation in the existing unique Run/Step
D1 fence; after enable, only a newly Published Plan with exact original
grants and the current generation can dispatch. Requests already sent cannot
be withdrawn. Replays after a reservation never re-POST.

The JSON request body is at most 4 KiB; response text is capped at 8 KiB,
with 12-second timeout and `redirect: manual`. Only HTTP 2xx represents a
successful **HTTP response**, not confirmed downstream business completion.
POST transport failure, redirect or non-2xx remains indeterminate; never
automatically retry unknown upstream effects. Nonmutating GET/HEAD errors
are reported as failures. DNS rebinding and arbitrary unreviewed hosts are
not independently proven safe by a hostname syntax check; use trusted
approved HTTPS domains and verify the real Workers egress boundary before
expanding target scope. No second scheduler, HTTP Worker binding, secrets
broker or standalone action registry is introduced.

### Live Portal Connection revocation (Spec #176 incremental vertical)

The **single fixed production MCP Portal** has an owner-controlled authorization state,
not an arbitrary connection registry. Owner tools `workflow_connection_status`,
`workflow_connection_revoke`, and `workflow_connection_enable` manage one durable
D1 generation. The new `0016_portal_connection_revocation.sql` migration initializes
`enabled`, generation `0`: older Published read-only MCP Plans remain valid until
revoke. The first revoke increments the generation and immediately denies new
protected `tools/call` reservations; repeated revoke/enable is idempotent.

The MCP invocation reserves a unique `(run_id, step_id)` D1 record with a single
SQL statement that also checks active Run, enabled Connection and the exact
Published Plan generation. A revocation winning this serialization forbids the
call; a reservation winning it can still reach the external service and is
**not** physically cancelled by revocation. Never reissue an uncertain call.
Enabling again **does not revive** a previously revoked Published Plan: explicitly
republish the Draft (including its original exact `approved_operations` and
`accept_target_risks`) to receive the new generation. Write-capable MCP
plans also need a fresh, exact `approve_mcp_write_execution` grant. This
uses the same Portal generation and one-shot fence; it does not authorize
arbitrary write tools, a generic Provider registry or cross-Provider revocation.

## MCP owner tools

`workflow_capabilities`, `workflow_action_list`, `workflow_connection_status`, `workflow_connection_revoke`, `workflow_connection_enable`, `workflow_list`, `workflow_get`, `workflow_create`, `workflow_update`, `workflow_validate`, `workflow_publish`, `workflow_approval`, `workflow_run`, `workflow_cancel`, `workflow_status`, `workflow_result`, `workflow_session_data_get`, `workflow_pause`, `workflow_resume` and `workflow_delete`.

`workflow_capabilities` reports the current compiler's supported and unsupported Triggers, Actions and Flow Control, the structural schema, limits and compiler-checked examples. Pass an optional `id` to inspect one capability. The existing `workflow_action_list` is the sole source of discovered approved-repository GitHub Actions; neither discovery call grants execution. Connection-specific Actions are reported as `unavailable` until the service's already-approved server-side Portal or GitHub configuration is present; no secrets are returned. The current compiler supports manual admission, one UTC Cron per Published Plan, result emission, grant-bound read-only MCP and one reviewed top-level IMA create/append note write, reviewed GitHub Task/Session Actions, bounded DAG dependencies and conditions. GitHub event ingress supports **push only**, through an explicitly installed, OIDC-signed GitHub Actions relay; no direct GitHub webhook, pull-request events or automatic event subscription.
Flow Control currently supports static branches/joins, literal bounded `flow: repeat`, bounded `flow: foreach` templates, `flow: wait`, one authenticated `flow: wait_event`, and **one pinned, nonrecursive** `flow: child` under exact Publish grants. Child calls are awaited by default; `mode: detached` returns a child Run reference after confirmed native creation and consumes a separate Run capacity slot. A detached child retains its own Published Plan and grants, and is not stopped by the parent completing or cancelling. Explicit `workflow_approval` supports **one top-level reviewed GitHub Task/Session gate**.
Nested loops, general Saga compensation and other/unreviewed MCP writes remain **unsupported** and fail at compilation. A bounded Saga exception supports only explicitly approved temporary `lirtual/session-actions` Ubuntu Session cancellation: source `saga.on` declares `failure` and/or `cancel`, each reversible Session step declares `compensate: {kind: github.session.cancel}`, and Publish separately requires `approve_saga_compensation` plus its exact GitHub grants. Native Cloudflare Workflows rolls back registered Steps in reverse start order; Saga execution is serialized to match inverse dependency order. A GitHub cancellation ACK is only a requested operation, never physical Session termination; the existing GitHub Attempt/Session reconciliation and TTL retain terminal authority. Other side effects are disallowed in Saga definitions, and no ACID rollback is claimed. The current `action.mcp.write` slice is restricted to static IMA `ima_create_note` and `ima_append_note` with one reviewed write per Plan; it does not provide arbitrary MCP writes, dynamic/foreach writes, automatic retry or write compensation. Arbitrary/credential-bearing HTTP requests remain unsupported; only the reviewed literal-target HTTP slice is available. `workflow_capabilities` exposes non-executable design contracts for these gaps, not valid Draft schemas or runnable examples. A configured Connection or discovered Action is never itself a Publish grant. An illustrative read-only MCP example only proves the definition compiles, not that the example tool exists or has been authorized.

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

### Literal bounded repeat

A fixed, reviewed number of iterations can be written as a single `flow: repeat` source entry. Its `times` must be a **literal integer from 1 to 8**, with exactly one `template` Action. During validation and Publish, the compiler expands each iteration into a regular sequential Step with stable IDs `<id>_0` through `<id>_<times-1>`, and validates all generated dependencies and Action contracts. The existing **32 total expanded Step** and **8 parallel ready Step** budgets still apply. There is no runtime loop interpreter, extra D1 schema or external scheduler.

```json
{
  "version": 1,
  "name": "Three deterministic reads",
  "inputs": {"message": "hello"},
  "steps": [
    {"id": "echo", "flow": "repeat", "times": 3,
      "template": {"uses": "result.emit", "with": {"data": {"ref": "inputs.message"}}}},
    {"id": "done", "needs": ["echo_2"], "uses": "result.emit",
      "with": {"data": "completed"}}
  ]
}
```

The template uses the same `uses`, `with` and optional `if` semantics as an ordinary Step; source-level `needs` apply to every iteration, and each later iteration additionally depends on the previous generated Step succeeding. A skipped/failed/indeterminate iteration does not automatically run later ones. Each iteration is a **real Action execution**: multiple GitHub Task or MCP calls are not coalesced; their ordinary Publish grants are still required. The compiler produces the same immutable Plan digest as an equivalent explicitly expanded DAG. No per-iteration index substitution, nested repeat, dynamic `times`, `foreach`, `while` or runtime result-driven expansion is supported.

### Authenticated external event wait

`flow: wait_event` waits for a signal delivered to **one existing Run/Step**, not a new Trigger:

```json
{"version":1,"name":"Wait for signal","steps":[
  {"id":"signal","flow":"wait_event","timeout_seconds":60,
   "token_sha256":"<SHA-256 hex of an independent 32-byte random base64url Bearer>"},
  {"id":"done","needs":["signal"],"uses":"result.emit",
   "with":{"data":{"ref":"steps.signal.output"}}}
]}
```

After explicit Publish and manual/Trigger Run admission, send `POST /events/{run_id}/signal`
with `Authorization: Bearer <event-secret>`, `X-Workflow-Event-Id: <stable-event-id>`,
`Content-Type: application/json` and an object body of at most 8192 bytes.
The secret is external and must never appear in the Draft. Each Published Plan
supports **one** external event wait with literal timeout 1–3600 seconds. A Run
remains within the existing capacity limits while waiting. Native events may
arrive before the Step starts; only the preauthorized logical event is accepted.
Delivery response `acknowledged` is **not** proof that the Step resumed. Use
`workflow_status` / `workflow_result` for the actual durable result. A 503
`unconfirmed` delivery may be retried with the identical ID and payload;
different signals are rejected. To cancel a pending event wait, use
`workflow_cancel({run_id,step_id:'signal'})`. This records the Run cancellation
in D1 before attempting native termination. Cancellation is accepted only while
the designated Step is actually waiting and no other Step is active. It never
claims that external effects have physically stopped. The independent bearer is not the Webhook
Trigger or Portal credential. No human approval or Saga semantics are implied.

### Bounded durable wait

Use an explicit `flow: wait` step when a Published Plan must delay its next
dependency without using an HTTP request, a polling Worker, or an extra scheduler:

```json
{
  "version": 1,
  "name": "Pause before reporting",
  "steps": [
    {"id":"hold","flow":"wait","duration_seconds":2},
    {"id":"done","uses":"result.emit","needs":["hold"],"with":{"data":"resumed"}}
  ]
}
```

The compiler accepts **literal integer seconds 1–300** and rejects a Plan
whose combined wait durations exceed **300 seconds**. Waiting occupies the
existing active Run quota slot. Cloudflare's native `step.sleep` checkpoint
survives a Worker restart; the Step appears as `waiting` until its duration
elapses, and dependencies cannot run before it completes.

This is a relative delay, **not** a signal/event wait, human Approval Gate or
an external wake-up endpoint. Paused workflows block new admission, not the
already-running Run. Native instance termination and external resource
cancellation are separate status checks; no compensation is promised.

### Bounded dynamic foreach (pure pipelines and reviewed single Actions)

A `flow: foreach` entry reads a JSON array from declared `inputs` or a completed dependency Step output. The declared `max_items` must be a literal integer from **1 to 8**. Its `template.steps` accepts **one** `result.emit`, read-scoped `mcp.call` or approved `github.run` Task Action, **or 2–4 ordered `result.emit` and reviewed read-only `mcp.call` Steps**. Each child may have safe `if`. Multi-step GitHub Tasks, Session Actions, arbitrary Task input expressions and nested templates remain rejected. The template may reference `item.value`, `item.value.<field>`, `item.index`, normal declared inputs and its controller's dependencies. For example:

```json
{
  "version": 1, "name": "Bounded item projection", "inputs": {"items": ["a", "b"]},
  "steps": [
    {"id": "each", "flow": "foreach", "items": {"ref": "inputs.items"},
      "max_items": 4,
      "template": {"steps": [{"id": "emit", "uses": "result.emit",
        "with": {"data": {"index": {"ref": "item.index"}, "value": {"ref": "item.value"}}}}]}},
    {"id": "out", "needs": ["each"], "uses": "result.emit",
      "with": {"data": {"ref": "steps.each.output"}}}
  ]
}
```

Before single-Action dispatch, a native **Cloudflare Workflow `step.do` checkpoint** freezes the full bounded list, each template condition, and evaluated result data or MCP tool arguments. In a multi-Step template, the array is snapshotted first; each pure emit uses its own native checkpoint, and each read-only MCP child freezes its condition and resolved arguments in a separate native checkpoint before its one-shot D1 fence and network call; later children can reference earlier children of the **same item** through `steps.<child-id>.status/output`. Each actual child receives a stable `<controller>_<index>_<template-id>` checkpoint and appears as a Step in status/results. Child outputs are returned in input order as a bounded array, with `null` for skipped items. An empty array skips the controller; an oversized or non-array input fails before executing any child. The compiler reserves **max_items × template.steps.length** children in the global **32-Step limit**, even if an actual Run contains fewer items.

A bounded template can instead call an **explicitly approved read-only MCP tool**. Use the same literal endpoint, tool name, scope, and pinned input/output schemas as a standalone `mcp.call`; only `arguments` may contain safe `item.value`/`item.index` expressions. `workflow_validate` and `workflow_publish` must collect and verify the exact child grant and `accept_target_risks`. One frozen child dispatch fence is persisted to the existing `run_steps` primary key **before** `tools/call`. A lost native checkpoint/response can therefore yield `indeterminate`, but must never cause an automatic second outbound attempt for the same child. This is **not** a claim of exactly-once remote effects or a replacement for peer-side idempotency. Live tool discovery/contract and the source's read-only annotation remain security preconditions; the annotation alone does not guarantee no side effects.

`flow.foreach_emit`, `flow.foreach_multi_emit`, `flow.foreach_mcp_read`, `flow.foreach_multi_mcp_read` and `flow.foreach_github_task` distinguish these limited modes. A reviewed GitHub Task template uses the existing pinned repository, release SHA/Tag, exact input contract and owner `approve_heavy_execution` with matching `approved_actions`; every item's `if` condition may use `item.value` or `item.index`, but GitHub Task inputs may be static literals **or exact current-item references** such as `{\"ref\":\"item.value\"}` / `{\"ref\":\"item.index\"}`. At Publish the immutable Action contract is re-read and pinned; before the first Task dispatch the complete bounded array is checked for type, choice, required fields and byte limits inside one native snapshot. Each selected Task's normalized input map receives a SHA-256 D1 marker before the unique Attempt, and the registration gate compares this marker before GitHub POST. Only the digest—not raw inputs—is recorded in the marker. Each selected Task has a stable <controller>_<index>_<template-id> identity: existing D1 UNIQUE Attempt registration occurs before the GitHub POST and the original GitHub-issued OIDC, Claim and physical terminal proof determine its final result. A missing native checkpoint cannot dispatch a second physical Task for the same child, and uncertain outcomes remain `indeterminate`; no exactly-once claim is made. One Foreach controller executes its selected Tasks sequentially to stay bounded.

Multi-step GitHub support permits **one reviewed, literal-input `github.run` Task among 2–4 ordered `result.emit` and reviewed read-only `mcp.call` children** per item. The previously shipped `result.emit → github.run → result.emit` path retains its checkpoint semantics. New mixed sequences require every earlier stage to succeed before running another stage; skipped, failed or indeterminate stages never authorize another external effect. Later children can use `steps.<Task-id>.output` only after a signed OIDC receipt and independently verified physical GitHub success. MCP children still use their own frozen arguments and one-shot D1 fences. No dynamic Task inputs, second GitHub Task, Session, write-scope tool or nested flow is supported in this multi-step path.

GitHub **Session** children, arbitrary expression-based Task inputs (exact current-item refs only in the existing *single-Action* template), **multiple GitHub Tasks in one per-item template or write-scope external Actions**, nested loops, write-scope/external-effect while/until loops beyond reviewed MCP reads, child workflows, general arbitrary HTTP Actions and general-purpose Saga compensation remain unsupported. Existing 32-Step budgeting applies to the maximum possible child count; this adds no Worker, D1 migration, external scheduler, service or second orchestration engine.

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

### Short-lived Session Runtime Data (Spec #288)

Windows UU Lite is the first and only admitted producer. The reviewed
`lirtual/session-actions/.github/workflows/windows.yml` GitHub-hosted physical
Session posts a bounded JSON observation to `POST /github/action/session-data`
with a fresh GitHub OIDC token, its claimed `attemptId`, the explicitly
allowlisted `uu.credentials` key and a strictly increasing per-Attempt sequence.
The signed physical Action, immutable Published Plan and owned Ready Session
must all agree. A successful UI observation is refreshed about every 30 seconds
(including unchanged values). An observed failure reports a no-ciphertext
`unavailable` tombstone; network failure cannot instantly revoke an observation
but can never extend the 90-second server-side TTL.

Use `workflow_session_data_get({run_id,step_id,key:'uu.credentials'})` **only when
the owner explicitly asks for UU connection details**. It returns `ready` with
`{device_id,verification_code,share_url?}` and `expires_at`, otherwise `unavailable`
with a safe reason code. Every successful read confirms a running GitHub physical
Run and rechecks the current sequence and cancellation fence before returning.
The existing MCP Portal Bearer remains a **single-owner shared credential**;
Run/Step IDs are locators, not independent ACLs. These codes enter conversation
history on an explicit read. Normal `workflow_status`, `workflow_result`, GitHub
logs, Summary, and Artifacts never include the codes.

The `0010_session_runtime_data.sql` migration uses only the existing D1; values
are AES-256-GCM ciphertext with unique IV and Run/Step/Attempt/key/sequence AEAD
binding. Supply `SESSION_RUNTIME_DATA_KEY` as a canonical Base64 32-byte Secret,
not a Variable. Never commit this key, and never use a shared permanent password
as its replacement. The existing GitHub Actions manual production release blocks
on this Secret, migration readiness, no active physical Session during schema
change, and ordinary approval gates. Worker CI and local D1 tests are necessary
but **not production acceptance**: only a real, approved temporary Windows Session
can prove UI collection, renewal, rotation, invalidation and normal cleanup. Keep
the implementation PR Draft and leave the Spec open until that end-to-end evidence
is collected. No extra Worker, cleanup Cron, queue, or auth service is introduced.

### Cloudflare Provider candidate (Spec #392; not deployed)

The generic `weixin.send_text` v3 accepts bounded, nonempty, publish-time
literal text (at most 2048 characters and 4096 UTF-8 bytes). An optional
`session_step_id` appends a verified same-Run OpenList Quick Tunnel URL; this
reference is validated at compile and execution time, not accepted from a
caller. An exact reviewed contract digest and immutable Worker version remain
mandatory. For literal-only messages a successful predecessor may be any
Workflow Step, subject to the existing DAG and persisted terminal-state checks. An exact reviewed contract digest and independent `approved_cloudflare_actions` plus `approve_cloudflare_execution=true` are required at Publish. A source-level Action does not grant execution; no arbitrary URL, receiver, Worker target, or RPC method can be supplied.

New v3 Plans use `ACTIONS` -> `cloudflare-actions#ActionsEntrypoint`. Historical v1/v2 Plans retain their old Worker identity and may read already-reserved receipts through the unified Worker after the cutover; they are never re-sent. During the authorized migration the old `WEIXIN_ACTION_PROVIDER` remains only for transitional compatibility. Production release and version pin are verified separately; no public Weixin MCP ingress is added. D1 migrations 0013 and 0018 retain immutable historical Plans.

A physically running GitHub Attempt and signed Ready callback are checked immediately before the D1 first-dispatch fence. The frozen Invocation ID, input digest, source Attempt and binding generation are stored without message text/URL. Once reservation succeeds, retries and recovery call `getReceipt` only. Missing receipts remain indeterminate; handset delivery is separately observed. Cancelling after reservation cannot retract a possible send. Session termination and capacity release use the existing GitHub lifecycle, not notification success.

### Historical terminal-Run release guard (2026-10-29)

The 2026-10-28 Owner-confirmed OpenList → Weixin Run
`9da5816a-e7d9-481a-8203-3a2036534563` remains machine
`indeterminate`/`cloudflare_outcome_unknown`. Its GitHub Job
`40722496262` and physical Session terminated, and Provider Invocation
`223af10e-dcf4-48c3-8c06-a39e60fa758b` retains a persisted
`unknown` machine receipt. Before any Workflow code-only release, the
manual main-only workflow independently verifies exact D1 Run/Steps/Session/
Attempt/Invocation identity plus native Cloudflare completion and GitHub
physical cancellation. Only that exact Run ID is excluded from the bounded
release counters after proof; unrelated nonterminal Runs still block release.
This changes no runtime business result, public API, history or send behavior.

### Safe Workflow deletion

Pause an active Workflow first, then call `workflow_delete` with its current
`workflow_id` and `expected_revision` (from `workflow_get`). Drafts can
be deleted directly. The D1 `deleted_at` tombstone hides definitions from
`workflow_list` and `workflow_get` and blocks all new triggers/admissions.
Immutable Versions, Runs, Steps and external receipts remain in D1 and Run
IDs continue to work with `workflow_status` / `workflow_result`. A repeated
delete is idempotent. Unsettled Runs, nonterminated physical Sessions and
published active/paused parent references block removal. No purging or restore
API is exposed. Migration `0014_workflow_deletion.sql` is additive and must
be applied through the existing guarded main-only release.

### Generic Owner Weixin notification (source candidate; not published)

After the separately authorized Provider and Workflow production releases,
republish the existing `download` Workflow with its `notify_weixin` Step using
`action: weixin.send_text`, `needs: [download_task]`, and
`input: {text: "Koofr 下载完成，云端文件回读校验已通过。"}`. The reviewed download Task
completes only after upload and remote SHA-256 readback. The literal text has
no path or secret. It is stored in the Published Plan, while runtime send
receipts store its digest only; do not put credentials in message literals. For an OpenList Ready notification use
`input: {text: "OpenList Session Ready\n", session_step_id: openlist}` and
`needs: [openlist]`; Workflow appends the authenticated canonical Session URL.
New notification purposes only supply a different literal `text` to the same
Action; no new Weixin RPC or business-specific Provider code is needed.

New v2 digests must match in both repositories; Publish additionally grants
the live Worker Version ID. Retain the two legacy RPCs until the existing
Published Plans have been migrated, in-flight Runs have drained, and rollout
has been independently verified. Immutable history and unknown receipts stay.
The current source change does not send, publish, pin, or migrate anything.

### Koofr download completed → Owner Weixin notification

The existing **legacy v1** `download` Workflow may append one top-level `action.run` using
`executor: cloudflare`, `provider: weixin`, `action: weixin.notify_download`,
`input: {download_step_id: download_task}` and `needs: [download_task]`.
The `download_task` must be a `max_items: 1` foreach containing the pinned
`lirtual/session-actions/.github/workflows/download.yml` GitHub Task; no
arbitrary Result or user-supplied success may authorize the notification.
The existing OIDC Claim and verified GitHub physical Task success prove completion;
the reviewed download Task only exits successfully after remote readback.
A D1 admission fence checks the same Run, both succeeded Steps, approved Task
Attempt, physical terminal and cancellation status atomically. The Weixin Provider
sends a fixed Owner-only success text without paths, URLs, tokens or arbitrary
message input. Failed, skipped and indeterminate downloads cannot notify.
Notifications remain at-most-one invocation with read-only recovery, and
the phone's receipt must be checked separately from an upstream acceptance.

### Action output discovery and static references

`workflow_action_list` reports `output_schema_status: not_declared` for GitHub
Task/Session Actions. GitHub `workflow_dispatch.inputs` describes inputs,
not a business output contract; a GitHub Job's physical status is not an
Action result schema. Cloudflare reviewed Actions expose their existing
`output_schema` through `workflow_capabilities`; MCP output declarations
remain subject to the exact live Portal contract and publish grants.

`workflow_validate({definition})` checks output field existence for literal
`result.emit` and source-reviewed closed Cloudflare outputs, as well as
provable numeric-reference type conflicts. Dynamic inputs, untrusted/open
schemas and undeclared GitHub/MCP outputs remain unknown rather than falsely
validated. Existing `needs`, runtime authorization and result bounds still apply.

For the source-reviewed `lirtual/session-actions` download Task,
`batch_json` is **one GitHub string input**, not a JSON object input. This
minimal example was syntax-checked with the provider's authoritative
`.github/scripts/download_batch.py` `validate()` function:

```json
{"remote":"koofr","downloads":[{"url":"https://example.com/file.zip","destination_dir":"Downloads"}],"project_purpose":"workflow download example","duration_minutes":30}
```

Encode this whole JSON document as the `batch_json` string; replace the
example URL and remote with real approved values. Successful syntax validation
is **not** remote authorization, proof of network access or a successful download.
Do not duplicate the provider's parser in Workflow MCP.
