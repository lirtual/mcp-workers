import { publicMcpEndpoint, PRODUCTION_PORTAL_ENDPOINT, TRUSTED_PORTAL_ENDPOINT } from './mcp-public-fetch.ts';
import { GITHUB_ASYNC_WAIT_MS, GITHUB_ASYNC_WAKE_LIMIT } from './github-async.ts';
import { APPROVAL_GATE_BINDING, APPROVAL_GATE_WHEN, APPROVAL_WAIT_MS } from './runtime-approval.ts';
import { selectedGithubExecutor } from './github-dispatch.ts';
import { CRON_CONTRACT } from './cron.ts';
import { REGISTERED_GITHUB_ACTION } from './github-registry.ts';

export const DEFINITION_KEYS = ['version', 'name', 'inputs', 'triggers', 'saga', 'steps'] as const;
export const STEP_KEYS = ['id', 'uses', 'needs', 'if', 'with', 'repeat', 'expand', 'compensate', 'approval'] as const;
export const SAGA_KEYS = ['on'] as const;
export const COMPENSATE_KEYS = ['tool', 'scope', 'arguments', 'input_schema', 'output_schema'] as const;
export const REPEAT_KEYS = ['times', 'until'] as const;
export const EXPAND_KEYS = ['items', 'max'] as const;
// Item values multiply this template. They cannot choose another action or connection.
export const EXPANSION_RISK = 'Each snapshotted item runs the published template once. Item values cannot select an action, endpoint, tool, or repository. A longer list is refused before those effects.';
// Tampered plans must fail closed. `steps` is legal only at the definition root.
export const NON_EXECUTABLE_PLAN_FIELDS = ['foreach', 'while', 'child', 'child_workflow', 'wait'] as const;
export const NON_EXECUTABLE_STEP_FIELDS = ['foreach', 'while', 'each', 'items', 'child', 'child_workflow', 'wait', 'sleep', 'delay', 'steps'] as const;
export const USES = ['result.emit', 'mcp.call', 'http.request', 'github.run', 'workflow.call'] as const;
export type SupportedUse = typeof USES[number];
export const WITH_KEYS: Record<SupportedUse, readonly string[]> = {
  'result.emit': ['data'],
  'mcp.call': ['endpoint', 'tool', 'scope', 'arguments', 'input_schema', 'output_schema'],
  'http.request': ['fixture', 'scope', 'arguments', 'input_schema', 'output_schema'],
  'github.run': ['capability'],
  'workflow.call': ['workflow_id', 'inputs', 'detach'],
};
export const GITHUB_CAPABILITY_ID = 'github.workflow.check';
export const MCP_SCOPE = 'read' as const;
export const MCP_SCOPES = ['read', 'write'] as const;
export const HTTP_FIXTURE_SCOPE = 'read' as const;
// Arguments must not choose the connection. Opaque MCP tool fields stay allowed.
export const HTTP_TARGET_ARGUMENT_KEYS = ['endpoint', 'url', 'uri', 'server', 'host', 'repository', 'repo', 'credential', 'credentials', 'token', 'secret', 'authorization', 'password', 'client_secret', 'client_id', 'method', 'headers', 'redirect'] as const;
export const CONDITION_OPS = ['ref', 'eq', 'ne', 'gt', 'lt', 'and', 'or', 'not'] as const;
export const CONDITION_VALUE_OPS = ['eq', 'ne', 'gt', 'lt', 'and', 'or', 'not'] as const;
export const RESERVED_EXPRESSION_KEYS = ['eval', 'javascript', 'script', 'code', 'shell', 'endpoint', 'url', 'command', 'function'] as const;
export const OBJECT_PROTOTYPE_KEYS = ['constructor', 'toString', 'toLocaleString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable'] as const;
export const STEP_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
export const TOOL_NAME = /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,127}$/;
export const WEBHOOK_TRIGGER_KEYS = ['id', 'type', 'source', 'event'] as const;
export const GITHUB_TRIGGER_KEYS = ['id', 'type', 'repository', 'events'] as const;
export const CRON_TRIGGER_KEYS = ['id', 'type', 'expression'] as const;
// Business triggers only. GitHub Action lifecycle events stay on the executor
// claim/callback routes and are not a second orchestrator.
export const GITHUB_TRIGGER_EVENTS = ['create', 'delete', 'issue_comment', 'issues', 'pull_request', 'push', 'release'] as const;
export const TRIGGER_SOURCE_ID = /^[a-z][a-z0-9-]{0,63}$/;
export const TRIGGER_EVENT_NAME = /^[a-z][a-z0-9_]{0,63}$/;
export const TRIGGER_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// Each repeat iteration is one Workflow step.do. The expanded budget stays on
// the existing 32-step cap, inside the platform step limit, and the deadline
// stays inside the 30-second step timeout.
const MAX_STEPS = 32;
export const LIMITS = {
  definitionBytes: 32 * 1024,
  minSteps: 1,
  maxSteps: MAX_STEPS,
  maxExpandedSteps: MAX_STEPS,
  maxLoopIterations: 8,
  maxLoopDepth: 1,
  maxLoopDeadlineMs: 10_000,
  maxParallel: 8,
  maxInputs: 32,
  maxNameLength: 120,
  maxExpressionDepth: 15,
  maxArrayLength: 100,
  minLogicOperands: 1,
  maxLogicOperands: 16,
  comparisonOperands: 2,
  maxToolSchemaBytes: 8192,
  maxDefinitionDepth: 32,
  maxAliasCount: 16,
  maxTriggers: 3,
  maxTriggerEvents: 8,
  // Advancing Runs are queued or running. A parent parked on an awaited child
  // is waiting and must not consume one of these slots.
  admissionCap: 8,
  maxChildDepth: 4,
  maxChildWaits: 40,
} as const;

export function isConfiguredSecret(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 16 && value.length <= 256 && !/[\r\n]/.test(value);
}

const PORTAL_ENDPOINTS: readonly string[] = [TRUSTED_PORTAL_ENDPOINT, PRODUCTION_PORTAL_ENDPOINT];

export function isSupportedUse(value: unknown): value is SupportedUse {
  return typeof value === 'string' && (USES as readonly string[]).includes(value);
}

/** No tsrv provider is registered. A name match is a block, not a session. */
export function isTsrvName(value: unknown): boolean {
  return typeof value === 'string' && /(^|[^a-z0-9])tsrv([^a-z0-9]|$)/i.test(value);
}

export const RESOURCE_PROVIDER_UNAVAILABLE = {
  status: 'unavailable' as const,
  reason: 'No tsrv resource provider is registered. A GitHub job result is not Ready.',
};

// The snapshot checkpoint is counted separately. A GitHub item also consumes
// its fixed receipt waits, still inside maxExpandedSteps.
export function expansionItemWeight(uses: SupportedUse): number {
  return uses === 'github.run' ? 1 + GITHUB_ASYNC_WAKE_LIMIT : 1;
}

const emitExample = {
  version: 1,
  name: 'Emit',
  steps: [
    {id: 'read', uses: 'result.emit', with: {data: {ref: 'inputs.subject'}}},
    {id: 'report', needs: ['read'], uses: 'result.emit',
      if: {eq: [{ref: 'steps.read.status'}, 'succeeded']},
      with: {data: {ref: 'steps.read.output'}}},
  ],
};
const mcpExample = {
  version: 1,
  name: 'Read MCP',
  inputs: {query: 'q'},
  steps: [{
    id: 'lookup',
    uses: 'mcp.call',
    with: {
      endpoint: PRODUCTION_PORTAL_ENDPOINT,
      tool: 'search',
      scope: 'read',
      input_schema: {type: 'object', properties: {query: {type: 'string'}}},
      arguments: {query: {ref: 'inputs.query'}},
    },
  }],
};
const mcpWriteExample = {
  version: 1,
  name: 'Write MCP',
  inputs: {note: 'n'},
  steps: [{
    id: 'save',
    uses: 'mcp.call',
    with: {
      endpoint: PRODUCTION_PORTAL_ENDPOINT,
      tool: 'note',
      scope: 'write',
      input_schema: {type: 'object', properties: {note: {type: 'string'}}, additionalProperties: false},
      arguments: {note: {ref: 'inputs.note'}},
    },
  }],
};
const httpExample = {
  version: 1,
  name: 'HTTP fixture',
  inputs: {value: 'ok'},
  steps: [{
    id: 'echo',
    uses: 'http.request',
    with: {
      fixture: 'echo',
      scope: 'read',
      input_schema: {type: 'object', properties: {value: {type: 'string'}}, additionalProperties: false},
      arguments: {value: {ref: 'inputs.value'}},
    },
  }],
};
const githubExample = {
  version: 1,
  name: 'GitHub check',
  steps: [
    {id: 'heavy', uses: 'github.run', with: {capability: GITHUB_CAPABILITY_ID}},
    {id: 'out', needs: ['heavy'], uses: 'result.emit', with: {data: {ref: 'steps.heavy.output'}}},
  ],
};
const registeredGithubExample = {
  version: 1,
  name: 'Registered GitHub action',
  inputs: {subject: 'build'},
  steps: [
    {id: 'act', uses: 'github.run', with: {
      capability: REGISTERED_GITHUB_ACTION.id,
      inputs: {subject: {ref: 'inputs.subject'}},
    }},
    {id: 'out', needs: ['act'], uses: 'result.emit', with: {data: {ref: 'steps.act.output'}}},
  ],
};
const parallelExample = {
  version: 1,
  name: 'Parallel',
  steps: [
    {id: 'left', uses: 'result.emit', with: {data: 'left'}},
    {id: 'right', uses: 'result.emit', with: {data: 'right'}},
  ],
};
const manualExample = {
  version: 1,
  name: 'Manual',
  steps: [{id: 'emit', uses: 'result.emit', with: {data: 'ok'}}],
};
const cronExample = {
  version: 1,
  name: 'Hourly',
  triggers: [{id: 'schedule', type: 'cron', expression: '15 * * * *'}],
  steps: [{id: 'emit', uses: 'result.emit', with: {data: {ref: 'inputs.event'}}}],
};
const webhookExample = {
  version: 1,
  name: 'Webhook',
  triggers: [{id: 'hook', type: 'webhook', source: 'approved-webhook', event: 'submitted'}],
  steps: [{id: 'emit', uses: 'result.emit', with: {data: {ref: 'inputs.event'}}}],
};
const githubEventExample = {
  version: 1,
  name: 'GitHub event',
  triggers: [{id: 'gh', type: 'github_event', repository: 'example/workflow', events: ['push']}],
  steps: [{id: 'emit', uses: 'result.emit', with: {data: {ref: 'inputs.event'}}}],
};
const expansionExample = {
  version: 1,
  name: 'Expand',
  steps: [
    {id: 'source', uses: 'result.emit', with: {data: ['one', 'two']}},
    {id: 'fan', needs: ['source'], uses: 'result.emit',
      expand: {items: {ref: 'steps.source.output'}, max: 4},
      with: {data: {index: {ref: 'expand.index'}, item: {ref: 'expand.item'}}}},
  ],
};
const sagaExample = {
  version: 1,
  name: 'Compensated write',
  saga: {on: ['failure', 'cancel']},
  inputs: {note: 'n'},
  steps: [
    {
      id: 'save',
      uses: 'mcp.call',
      with: {
        endpoint: PRODUCTION_PORTAL_ENDPOINT,
        tool: 'note',
        scope: 'write',
        input_schema: {type: 'object', properties: {note: {type: 'string'}}, additionalProperties: false},
        arguments: {note: {ref: 'inputs.note'}},
      },
      compensate: {
        tool: 'note_clear',
        scope: 'write',
        input_schema: {type: 'object', properties: {note: {type: 'string'}}, additionalProperties: false},
        arguments: {note: {ref: 'inputs.note'}},
      },
    },
    {id: 'after', needs: ['save'], uses: 'result.emit', with: {data: {ref: 'steps.save.output'}}},
  ],
};
const childExample = {
  version: 1,
  name: 'Call published child',
  inputs: {subject: 'seed'},
  steps: [
    {id: 'call', uses: 'workflow.call', with: {
      workflow_id: '00000000-0000-4000-8000-000000000001',
      inputs: {subject: {ref: 'inputs.subject'}},
    }},
    {id: 'report', needs: ['call'], uses: 'result.emit', with: {data: {ref: 'steps.call.output'}}},
  ],
};
const repeatExample = {
  version: 1,
  name: 'Bounded loop',
  steps: [
    {id: 'seed', uses: 'result.emit', with: {data: 'seed'}},
    {id: 'grow', needs: ['seed'], uses: 'result.emit',
      repeat: {times: 3, until: {eq: [{ref: 'loop.index'}, 2]}},
      if: {lt: [{ref: 'loop.index'}, 2]},
      with: {data: {
        index: {ref: 'loop.index'},
        seed: {ref: 'steps.seed.output'},
        prev: {ref: 'steps.grow.output'},
      }}},
  ],
};

type Kind = 'trigger' | 'action' | 'flow';
type SupportedEntry = {
  id: string;
  kind: Kind;
  status: 'supported';
  summary: string;
  example: unknown;
  uses?: SupportedUse;
  scope?: 'read' | 'write';
  permissions: string;
  completion: string;
};
type UnsupportedEntry = {
  id: string;
  kind: Kind;
  status: 'unsupported';
  summary: string;
};
type Entry = SupportedEntry | UnsupportedEntry;

const CATALOG: readonly Entry[] = [
  {id: 'trigger.manual', kind: 'trigger', status: 'supported', example: manualExample,
    summary: 'Start the published plan by calling workflow_run. Manual start does not declare a trigger.',
    permissions: 'Publishing a Draft does not start a Run. workflow_run admits one manual Run of the pinned published plan.',
    completion: 'The Run is queued. Poll workflow_status and workflow_result. Inputs are an untyped object; typed input checks are unsupported.'},
  {id: 'trigger.cron', kind: 'trigger', status: 'supported', example: cronExample,
    summary: 'A published five-field UTC cron admits a Run from this Worker scheduled event. The minimum interval is 60 seconds. UTC has no DST, and a timezone field is rejected.',
    permissions: 'Only an authenticated workflow_publish arms a cron. A Draft does not. There is no public cron route and no extra secret. The schedule cannot name a URL, command, timezone, or Worker. Pause blocks new admissions and does not move in-flight Runs. Removing the cron and publishing again stops later ticks.',
    completion: 'This Worker uses one Cloudflare scheduled event, '+CRON_CONTRACT.platform_cron+', and does not deploy a cron per user schedule. A matching active Published Version admits one Run through the same D1 path as workflow_run and pins that version. Duplicate or late wakes for the same UTC minute return that Run. A missed platform minute is not backfilled. Capacity-refused minutes persist for at most 24 hours, with a 10,000-entry global cap; expired entries are dropped and overflow is reported on admission. This does not promise exactly-once. Publish, pause, draft update, and disabling the cron change the next tick without a redeploy.'},
  {id: 'trigger.webhook', kind: 'trigger', status: 'supported', example: webhookExample,
    summary: 'An authenticated webhook can admit a Run of the published plan. Declare triggers, not a top-level webhook field.',
    permissions: 'Publish accepts the webhook only when source equals the configured source and a signing secret is configured. The secret is never returned, logged, or stored in the plan. POST /triggers/webhook/{workflow_id} with X-Workflow-Signature-256.',
    completion: 'Admission is the same path as workflow_run and pins the published version active at the first admission. A later publish does not move that Run. Replaying the same X-Workflow-Event-Id returns that Run. A new id after a version switch uses the version active at admission. A delivery while paused is rejected and not stored. A missing stable event id is not deduplicated. This does not promise global exactly-once.'},
  {id: 'trigger.github_event', kind: 'trigger', status: 'supported', example: githubEventExample,
    summary: 'An authenticated GitHub repository event can admit a Run. github.run remains a step, not an event trigger.',
    permissions: 'Publish accepts the repository only when it equals the configured executor repository and a webhook secret is configured. The secret is never returned. Allowed events are create, delete, issue_comment, issues, pull_request, push, and release. workflow_run, workflow_job, and the GitHub Action claim/callback routes do not start a business Run.',
    completion: 'POST /triggers/github/{workflow_id} verifies X-Hub-Signature-256 and then uses the same Run admission as workflow_run. X-GitHub-Delivery dedupes that delivery only. A missing delivery id is not deduplicated. A new delivery id is a new admission. This does not promise global exactly-once.'},
  {id: 'action.result.emit', kind: 'action', status: 'supported', uses: 'result.emit', example: emitExample,
    summary: 'Evaluate a JSON value and store it as the step output. No network.',
    permissions: 'No grant. data is an expression, not a command.',
    completion: 'Completes inside the step with the evaluated data.'},
  {id: 'action.mcp.call', kind: 'action', status: 'supported', uses: 'mcp.call', scope: 'read', example: mcpExample,
    summary: 'Call one read-only MCP tool through the configured portal after publish-time approval. An already authorized read does not wait for a runtime approval.',
    permissions: 'scope must be read. Publish requires approved_operations exactly matching endpoint, tool, scope, and schema_digest, plus accept_target_risks=true. The endpoint must be the configured portal. A public URL shape is not authorization. Do not set schema_digest; the compiler adds it. readOnlyHint is not a grant. Do not set approval. Arguments cannot add a gate or change this scope.',
    completion: 'One tools/call after grants and a live read-only schema check. A lost response is indeterminate and is not retried. Revocation blocks a later call. An effect already dispatched stays its real result or indeterminate.'},
  {id: 'action.mcp.write', kind: 'action', status: 'supported', uses: 'mcp.call', scope: 'write', example: mcpWriteExample,
    summary: 'Call one exact portal tool whose published scope is write. Optional approval.required waits once before that dispatch. This is not an arbitrary write and not a public MCP marketplace.',
    permissions: 'scope must be write. The endpoint, tool, and schema_digest are pinned. Publish requires that exact approved_operations entry and accept_target_risks=true. readOnlyHint cannot authorize the call. Runtime arguments cannot change the server, URL, repository, credential, or this scope, and cannot set approval. Omit approval and an already authorized write does not wait. Set approval.required to true and the Run waits until one workflow_approval for that run, step, and published version. The server does not create that approval. A compensate block is not implied. flow.saga must publish it as its own grant or this write is not compensated.',
    completion: 'One tools/call after the grant, schema, and an explicit readOnlyHint false check. A missing or true readOnlyHint fails closed before tools/call. A lost response is indeterminate and is not retried or rolled back.'},
  {id: 'action.github.run', kind: 'action', status: 'supported', uses: 'github.run', example: githubExample,
    summary: 'Run the registered GitHub Workflow CI check. Optional approval.required waits once before dispatch. The definition cannot choose a repository, ref, workflow file, token, or command.',
    permissions: 'Publish requires approve_heavy_execution=true. Runtime uses the server GitHub executor and OIDC. with accepts only capability github.workflow.check. Set approval.required to true to wait for one workflow_approval bound to the run, step, and published version before dispatch. Arguments cannot set that gate. The server does not create it. Omit approval and publish-time heavy-execution approval is enough.',
    completion: 'Dispatch accepted stores the GitHub run id on the Attempt. The step stays pending until one claimed receipt or the explicit '+String(GITHUB_ASYNC_WAIT_MS/1000)+' second wait ends. That receipt is the external terminal result. Lost, duplicate, early, and late wakes are not a second result. Worker recovery keeps the same Attempt. An ambiguous dispatch or timeout is indeterminate and is not dispatched again. workflow_cancel asks GitHub to cancel a waiting or running run and keeps reading that run and its jobs. Accepted cancellation is requested, not stopped. Observed success or failure is completed. Unknown physical state is indeterminate. The cancel call is not repeated and is not a force-cancel.'},
  {id: 'action.github.registered', kind: 'action', status: 'supported', uses: 'github.run', example: registeredGithubExample,
    summary: 'Dispatch one allow-listed GitHub workflow. Optional approval.required waits once before dispatch. The definition supplies schema inputs only. Repository '+REGISTERED_GITHUB_ACTION.repository+', workflow '+REGISTERED_GITHUB_ACTION.workflow+', ref '+REGISTERED_GITHUB_ACTION.ref+'. Grant '+REGISTERED_GITHUB_ACTION.grant+'.',
    permissions: 'Publish requires approve_heavy_execution=true. The repository, workflow file, and ref are the source allow-list, not definition fields. Inputs must match the subject schema. No shell and no other repository. Set approval.required to true to wait for one workflow_approval bound to the run, step, and published version before dispatch. Arguments cannot set that gate. The server does not create it.',
    completion: 'Dispatch accepted stores the GitHub run id before the run finishes. The step stays dispatch_accepted until a read of that same run records external_terminal success or failure. An ambiguous dispatch or run read is indeterminate and is not dispatched again. The result lists artifact metadata and a repository-scoped URL, not file bytes. workflow_cancel asks GitHub to cancel a waiting or running run and keeps reading that run and its jobs. Accepted cancellation is requested, not stopped. Observed success or failure is completed. Unknown physical state is indeterminate. The cancel call is not repeated and is not a force-cancel.'},
  {id: 'action.http', kind: 'action', status: 'supported', uses: 'http.request', scope: 'read', example: httpExample,
    summary: 'Call the one registered HTTP fixture. An already authorized read does not wait for a runtime approval. The definition cannot choose a URL, method, header, or credential.',
    permissions: 'scope must be read. with accepts fixture, scope, arguments, and schemas. Publish requires approved_operations exactly matching fixture, endpoint, scope, and schema_digest, plus accept_target_risks=true. The endpoint comes from the server fixture, not from the definition or runtime arguments. Do not set approval. Arguments cannot add a gate or change this scope.',
    completion: 'One POST to the pinned fixture after the grant and schema check. Redirects are not followed. A lost response or redirect is indeterminate and is not retried or rolled back.'},
  {id: 'action.tsrv', kind: 'action', status: 'unsupported',
    summary: 'tsrv resource actions are unavailable. No resource provider is registered, so this cannot return an owned expiring reference at Ready. A GitHub job result is not Ready. Validate and publish reject this action.'},
  {id: 'action.shell', kind: 'action', status: 'unsupported',
    summary: 'Shell and arbitrary commands are not implemented.'},
  {id: 'flow.needs', kind: 'flow', status: 'supported', example: emitExample,
    summary: 'needs names earlier steps. The compiler sorts a static DAG by step id.',
    permissions: 'A step may read only inputs or the status and output of steps it needs.',
    completion: 'Dependencies run to a terminal step state before dependents start.'},
  {id: 'flow.if', kind: 'flow', status: 'supported', example: emitExample,
    summary: 'if is a boolean or one operator: ref, eq, ne, gt, lt, and, or, not.',
    permissions: 'Conditions cannot call the network or evaluate code.',
    completion: 'A false condition skips the step without an external effect.'},
  {id: 'flow.parallel', kind: 'flow', status: 'supported', example: parallelExample,
    summary: `Steps with no unmet needs run together, at most ${LIMITS.maxParallel} at a time.`,
    permissions: 'Parallelism does not add actions or grants.',
    completion: 'Each ready wave is bounded. A larger wave is rejected at validate.'},
  {id: 'flow.repeat', kind: 'flow', status: 'supported', example: repeatExample,
    summary: `Repeat one result.emit step a literal times from 1 to ${LIMITS.maxLoopIterations}. until is checked before each iteration. loop.index and steps.<this-step>.output refer to the iteration and the previous output.`,
    permissions: 'No grant. The repeated action must be result.emit. mcp.call, http.request, and github.run stay outside repeat.',
    completion: `Each iteration that runs is one Workflow step. A false if skips that iteration. until stops before the iteration. The step output is the last completed iteration. The loop stops at ${LIMITS.maxLoopDeadlineMs} milliseconds.`},
  {id: 'flow.foreach', kind: 'flow', status: 'unsupported',
    summary: 'foreach is not implemented. Do not add a foreach field. repeat.times must be a literal integer, not a list.'},
  {id: 'flow.while', kind: 'flow', status: 'unsupported',
    summary: 'while is not implemented. Do not add a while field. Bounded repetition is repeat.times with optional repeat.until.'},
  {id: 'flow.nesting', kind: 'flow', status: 'unsupported',
    summary: `Nested steps and nested loops are not implemented. Do not add a steps or body field. Loop depth is ${LIMITS.maxLoopDepth}.`},
  {id: 'flow.dynamic_expansion', kind: 'flow', status: 'supported', example: expansionExample,
    summary: 'Expand one published template from a needed step output. expand.max caps the list. The snapshot and stable ids (template id, a colon, and the snapshot index) are stored before any expanded external effect.',
    permissions: 'The template is this step uses and with. mcp.call still needs the read grant and target-risk acceptance. github.run still needs heavy-execution approval. Runtime cannot add an action or connection.',
    completion: `Validate and publish state cap ${LIMITS.maxExpandedSteps}, the template, dependencies, and the risk of one effect per snapshotted item. A longer list fails before those effects. Replay keeps the stored ids. Waves stay within ${LIMITS.maxParallel}. Depth stays ${LIMITS.maxLoopDepth}. foreach, while, nested steps, and durable wait stay unsupported. Saga is a separate published policy, not an expansion. A child workflow call is its own step, not an expansion template.`},
  {id: 'flow.wait', kind: 'flow', status: 'unsupported',
    summary: 'Durable wait is not implemented. Do not add wait, sleep, or delay. GitHub receipt waiting is not a definition field.'},
  {id: 'flow.child_workflow', kind: 'flow', status: 'supported', uses: 'workflow.call', example: childExample,
    summary: `Call one published workflow by id. The default waits for that child Run. detach true starts it and does not wait. Call depth is at most ${LIMITS.maxChildDepth}.`,
    permissions: 'workflow_id is a literal published workflow id. inputs may use only keys that child declares, and cannot select a connection or carry a server credential. The child Run uses its own published plan and grants, never the parent grants.',
    completion: `The child is admitted as its own D1 Run and Cloudflare Workflow, pinned to the child version active at admission. The awaited step output is the child result, and failure or an indeterminate child is the parent step outcome. This invocation waits at most ${LIMITS.maxChildWaits} times, 30 seconds each. If the child is still not terminal, the parent step is child_wait_unconfirmed and a later child success is not copied onto that step. detach true leaves that child running when the parent finishes and workflow_cancel does not include it. workflow_cancel on the parent requests cancel only for awaited children. Requested is not stopped; the real instance is reconciled. A waiting parent does not hold one of the ${LIMITS.admissionCap} advancing admissions. A deeper call than ${LIMITS.maxChildDepth} is refused.`},
  {id: 'flow.saga', kind: 'flow', status: 'supported', example: sagaExample,
    summary: 'Compensate a completed controlled portal write only when saga.on and that step compensate were published. This is not an ACID rollback.',
    permissions: 'saga.on lists failure, cancel, or both. compensate names the tool, scope, arguments, and schema on that same endpoint. Publish must include that grant in approved_operations and accept_target_risks. A step without compensate is not compensated. Revocation blocks the compensation call.',
    completion: 'When a later step fails, or workflow_cancel runs and cancel was published, this runner compensates completed writes in reverse dependency order before the instance is terminated. If that runner does not store the compensation report within the cancel grace, the run is indeterminate rather than cancelled. One failed or unknown compensation does not skip every other granted compensation. Parallel branches, replay, and an indeterminate dispatch stay partial or unknown. The report sets acid_rollback to false. There is no saga worker and no extra queue.'},
];

export const supportedCapabilityExamples: readonly unknown[] = CATALOG.flatMap(entry =>
  entry.status === 'supported' ? [entry.example] : []);

export function capabilityCatalog(): ReadonlyArray<{id: string; kind: Kind; status: 'supported' | 'unsupported'; summary: string}> {
  return CATALOG.map(({id, kind, status, summary}) => ({id, kind, status, summary}));
}

function registeredCatalogFields() {
  const action = REGISTERED_GITHUB_ACTION;
  return {
    capability: action.id,
    repository: action.repository,
    repository_id: action.repositoryId,
    workflow: action.workflow,
    ref: action.ref,
    grant: action.grant,
    input_schema: action.inputSchema,
    with_keys: ['capability', 'inputs'],
  };
}

export type CapabilityEnv = {
  MCP_PORTAL_ENDPOINT?: string;
  WORKFLOW_EXECUTOR_GITHUB_TOKEN?: string;
  GITHUB_EXECUTOR_REPOSITORY?: string;
  GITHUB_EXECUTOR_REPOSITORY_ID?: string;
  GITHUB_EXECUTOR_REF?: string;
  GITHUB_EXECUTOR_AUDIENCE?: string;
  GITHUB_TEST_WORKER_NAME?: string;
  GITHUB_TEST_DEDICATED_EXECUTOR?: string;
  WEBHOOK_TRIGGER_SOURCE?: string;
  WEBHOOK_TRIGGER_SECRET?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  HTTP_FIXTURE_ID?: string;
  HTTP_FIXTURE_URL?: string;
  HTTP_FIXTURE_SCHEMA_DIGEST?: string;
};

/** The one server-pinned HTTP fixture. An illegal or incomplete pin stays unavailable. */
export function readHttpFixture(env: CapabilityEnv): {fixture: string; endpoint: string; schema_digest: string} | null {
  const fixture = env.HTTP_FIXTURE_ID;
  const endpoint = env.HTTP_FIXTURE_URL;
  const schema_digest = env.HTTP_FIXTURE_SCHEMA_DIGEST;
  if (!fixture || !endpoint || !schema_digest || !TRIGGER_SOURCE_ID.test(fixture) || !/^[0-9a-f]{64}$/.test(schema_digest))
    return null;
  try {
    if (publicMcpEndpoint(endpoint).href !== endpoint) return null;
  } catch {
    return null;
  }
  return {fixture, endpoint, schema_digest};
}

function triggerConnections(env: CapabilityEnv) {
  const webhookSource = env.WEBHOOK_TRIGGER_SOURCE;
  const webhookSecret = env.WEBHOOK_TRIGGER_SECRET;
  const webhook = isConfiguredSecret(webhookSecret) && webhookSource && TRIGGER_SOURCE_ID.test(webhookSource) &&
    !webhookSource.includes(webhookSecret)
    ? {status: 'configured' as const, source: webhookSource}
    : {status: 'unavailable' as const};
  const repository = env.GITHUB_EXECUTOR_REPOSITORY;
  const githubSecret = env.GITHUB_WEBHOOK_SECRET;
  const github_events = isConfiguredSecret(githubSecret) && repository && TRIGGER_REPOSITORY.test(repository) &&
    !repository.includes(githubSecret)
    ? {status: 'configured' as const, repository}
    : {status: 'unavailable' as const};
  return {webhook, github_events};
}

// Absent pins stay unavailable. Never echo tokens or an unconfigured endpoint.
export function connectionSummary(env: CapabilityEnv) {
  const portal = env.MCP_PORTAL_ENDPOINT;
  const mcp_portal = portal !== undefined && PORTAL_ENDPOINTS.includes(portal)
    ? {status: 'configured' as const, endpoint: portal, scope: MCP_SCOPE, scopes: MCP_SCOPES,
      publish: 'approved_operations must match endpoint, tool, scope, and schema_digest, and accept_target_risks must be true. scope write is one exact portal tool. readOnlyHint is not a grant.'}
    : {status: 'unavailable' as const};
  const http = readHttpFixture(env);
  const http_fixture = http
    ? {status: 'configured' as const, fixture: http.fixture, endpoint: http.endpoint, scope: HTTP_FIXTURE_SCOPE,
      method: 'POST' as const, schema_digest: http.schema_digest,
      publish: 'approved_operations must match fixture, endpoint, scope, and schema_digest, and accept_target_risks must be true'}
    : {status: 'unavailable' as const};
  const githubReady = Boolean(env.WORKFLOW_EXECUTOR_GITHUB_TOKEN && env.GITHUB_EXECUTOR_REPOSITORY &&
    env.GITHUB_EXECUTOR_REPOSITORY_ID && env.GITHUB_EXECUTOR_REF && env.GITHUB_EXECUTOR_AUDIENCE);
  const triggers = triggerConnections(env);
  const resource_provider = RESOURCE_PROVIDER_UNAVAILABLE;
  if (!githubReady) return {mcp_portal, http_fixture, github_executor: {status: 'unavailable' as const}, resource_provider, ...triggers};
  try {
    const workflow = selectedGithubExecutor(env).workflow;
    return {mcp_portal, http_fixture, github_executor: {
      status: 'configured' as const,
      repository: env.GITHUB_EXECUTOR_REPOSITORY,
      ref: env.GITHUB_EXECUTOR_REF,
      workflow,
      audience: env.GITHUB_EXECUTOR_AUDIENCE,
    }, resource_provider, ...triggers};
  } catch {
    return {mcp_portal, http_fixture, github_executor: {status: 'unavailable' as const}, resource_provider, ...triggers};
  }
}

function definitionContract() {
  return {
    version: 1 as const,
    format: 'JSON object or YAML mapping',
    keys: DEFINITION_KEYS,
    step_keys: STEP_KEYS,
    uses: USES,
    condition_ops: CONDITION_OPS,
    reserved_expression_keys: RESERVED_EXPRESSION_KEYS,
    limits: {
      max_definition_bytes: LIMITS.definitionBytes,
      min_steps: LIMITS.minSteps,
      max_steps: LIMITS.maxSteps,
      max_parallel_steps: LIMITS.maxParallel,
      max_loop_iterations: LIMITS.maxLoopIterations,
      max_expanded_steps: LIMITS.maxExpandedSteps,
      max_loop_depth: LIMITS.maxLoopDepth,
      max_loop_deadline_ms: LIMITS.maxLoopDeadlineMs,
      max_inputs: LIMITS.maxInputs,
      max_name_length: LIMITS.maxNameLength,
      max_expression_depth: LIMITS.maxExpressionDepth,
      max_expression_array: LIMITS.maxArrayLength,
      max_tool_schema_bytes: LIMITS.maxToolSchemaBytes,
      max_triggers: LIMITS.maxTriggers,
      max_child_depth: LIMITS.maxChildDepth,
      admission_cap: LIMITS.admissionCap,
    },
    manual_start: 'Call workflow_run after explicit publish. Omit triggers for a manual-only definition. Typed input checks are unsupported.',
    event_admission: 'Webhook, GitHub event, and cron deliveries admit through the same Run path as workflow_run. A stable event id dedupes to one Run of the version active at first admission. A missing stable event id does not promise exactly-once. Cron uses the UTC scheduled minute as that id. A missed platform minute is not backfilled.',
    cron: CRON_CONTRACT,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['version', 'name', 'steps'],
      properties: {
        version: {const: 1},
        name: {type: 'string', minLength: 1, maxLength: LIMITS.maxNameLength},
        inputs: {type: 'object', maxProperties: LIMITS.maxInputs},
        triggers: {
          type: 'array', minItems: 1, maxItems: LIMITS.maxTriggers,
          description: 'Optional. At most one webhook, one github_event, and one cron. Cron expression is five UTC fields with a 60 second minimum. No timezone or DST.',
        },
        saga: {
          type: 'object', additionalProperties: false, required: ['on'],
          description: 'Optional explicit compensation policy. Steps compensate only when they also set compensate. Not an ACID rollback.',
          properties: {
            on: {type: 'array', minItems: 1, maxItems: 2, items: {enum: ['failure', 'cancel']}},
          },
        },
        steps: {
          type: 'array', minItems: LIMITS.minSteps, maxItems: LIMITS.maxSteps,
          items: {
            type: 'object', required: ['id', 'uses', 'with'],
            properties: {
              id: {type: 'string'}, uses: {enum: USES},
              repeat: {
                type: 'object', additionalProperties: false, required: ['times'],
                properties: {
                  times: {type: 'integer', minimum: 1, maximum: LIMITS.maxLoopIterations},
                  until: {description: 'Checked before each iteration. A boolean or one condition operator.'},
                },
              },
              expand: {
                type: 'object', additionalProperties: false, required: ['items', 'max'],
                properties: {
                  items: {description: 'A ref to a needed step output. Not a literal list.'},
                  max: {type: 'integer', minimum: 1, maximum: LIMITS.maxExpandedSteps},
                },
              },
              approval: {
                type: 'object', additionalProperties: false, required: ['required'],
                properties: {required: {const: true}},
                description: 'Optional runtime gate for a portal write or GitHub step only. Reads must omit it. Arguments cannot set it or widen scope. It fires once before dispatch and binds the run, step, and published version.',
              },
            },
          },
        },
      },
    },
  };
}
const approvalField = {
  type: 'object', additionalProperties: false, required: ['required'],
  properties: {required: {const: true}},
  description: 'Optional. required must be true. Arguments cannot set this or widen the published scope.',
};
const highImpactApproval = new Set(['action.mcp.write', 'action.github.run', 'action.github.registered']);
function approvalGateDetail(id: string) {
  if (id === 'action.mcp.call' || id === 'action.http') return {
    high_impact: false as const,
    optional: false as const,
    scope: 'read' as const,
    when: 'not_used' as const,
    binding: [] as string[],
    effect: 'none' as const,
    declaration: 'Do not set approval. An already authorized read does not wait.',
  };
  if (!highImpactApproval.has(id)) return undefined;
  return {
    high_impact: true as const,
    optional: true as const,
    scope: id === 'action.mcp.write' ? 'write' as const : 'github_execution' as const,
    when: APPROVAL_GATE_WHEN,
    binding: [...APPROVAL_GATE_BINDING],
    effect: 'once' as const,
    timeout_ms: APPROVAL_WAIT_MS,
    declaration: 'Set step approval.required to true. The gate fires once before the external dispatch. workflow_approval is accepted only while that gate is open and before its deadline. A decision before the gate opens, after the deadline, or after it was consumed does not dispatch. One decision must match the run, step, and published version. Denial, timeout, a repeat, and any other binding do not dispatch. Publish does not create this approval. Arguments cannot set it or change the scope.',
  };
}
function stepSchema(uses: SupportedUse, approval = false) {
  const withKeys = WITH_KEYS[uses];
  return {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'uses', 'with'],
    properties: {
      id: {type: 'string', pattern: STEP_ID.source},
      uses: {const: uses},
      needs: {type: 'array', items: {type: 'string', pattern: STEP_ID.source}},
      if: {description: 'A boolean or one operator: ' + CONDITION_OPS.join(', ')},
      ...(approval ? {approval: approvalField} : {}),
      with: {
        type: 'object',
        additionalProperties: false,
        required: uses === 'mcp.call'
          ? ['endpoint', 'tool', 'scope', 'arguments', 'input_schema']
          : uses === 'http.request'
            ? ['fixture', 'scope', 'arguments', 'input_schema']
            : uses === 'workflow.call'
              ? ['workflow_id']
              : [...withKeys],
        properties: Object.fromEntries(withKeys.map(key => [key, {description: key}])),
      },
    },
  };
}

function detailOf(entry: Entry) {
  const base = {id: entry.id, kind: entry.kind, status: entry.status, summary: entry.summary};
  if (entry.status !== 'supported') return base;
  const action = entry.uses ? {
    uses: entry.uses,
    with_keys: WITH_KEYS[entry.uses],
    schema: stepSchema(entry.uses, entry.id === 'action.mcp.write' || entry.id === 'action.github.run'),
    ...(entry.uses === 'github.run' ? {capability: GITHUB_CAPABILITY_ID} : {}),
    ...(entry.scope ? {scope: entry.scope} : {}),
  } : entry.id === 'trigger.cron' ? {
    schema: {
      type: 'object', additionalProperties: false, required: ['id', 'type', 'expression'],
      properties: {
        id: {type: 'string', pattern: STEP_ID.source},
        type: {const: 'cron'},
        expression: {type: 'string', minLength: 9, maxLength: 128, description: CRON_CONTRACT.format},
      },
    },
    cron: CRON_CONTRACT,
    limits: {minimum_interval_seconds: CRON_CONTRACT.minimum_interval_seconds},
  } : {schema: definitionContract().schema};
  const gate = approvalGateDetail(entry.id);
  return {...base, ...action, permissions: entry.permissions, completion: entry.completion, example: entry.example,
    ...(gate ? {approval_gate: gate} : {}),
    ...(entry.id === 'action.github.registered' ? {...registeredCatalogFields(), schema: {
      type: 'object', additionalProperties: false, required: ['id', 'uses', 'with'],
      properties: {
        id: {type: 'string', pattern: STEP_ID.source},
        uses: {const: 'github.run'},
        approval: approvalField,
        with: {
          type: 'object', additionalProperties: false, required: ['capability', 'inputs'],
          properties: {
            capability: {const: REGISTERED_GITHUB_ACTION.id},
            inputs: REGISTERED_GITHUB_ACTION.inputSchema,
          },
        },
      },
    }} : {}),
    ...(entry.id === 'flow.parallel' ? {limits: {max_parallel_steps: LIMITS.maxParallel}} : {}),
    ...(entry.id === 'flow.if' ? {condition_ops: CONDITION_OPS} : {}),
    ...(entry.id === 'flow.repeat' ? {
      condition_ops: CONDITION_OPS,
      repeat_keys: REPEAT_KEYS,
      limits: {
        max_iterations: LIMITS.maxLoopIterations,
        max_expanded_steps: LIMITS.maxExpandedSteps,
        max_parallel_steps: LIMITS.maxParallel,
        max_loop_depth: LIMITS.maxLoopDepth,
        max_loop_deadline_ms: LIMITS.maxLoopDeadlineMs,
      },
    } : {}),
    ...(entry.id === 'flow.saga' ? {
      boundary: 'not_an_acid_rollback',
      triggers: ['failure', 'cancel'],
      saga_keys: SAGA_KEYS,
      compensate_keys: COMPENSATE_KEYS,
    } : {}),
    ...(entry.id === 'flow.child_workflow' ? {
      limits: {
        admission_cap: LIMITS.admissionCap,
        max_child_depth: LIMITS.maxChildDepth,
        max_child_waits: LIMITS.maxChildWaits,
      },
    } : {}),
    ...(entry.id === 'flow.dynamic_expansion' ? {
      expand_keys: EXPAND_KEYS,
      template_uses: USES.filter(use => use !== 'workflow.call'),
      risk: EXPANSION_RISK,
      limits: {
        cap: LIMITS.maxExpandedSteps,
        max_parallel_steps: LIMITS.maxParallel,
        max_loop_depth: LIMITS.maxLoopDepth,
        max_loop_iterations: LIMITS.maxLoopIterations,
        github_wait_steps: GITHUB_ASYNC_WAKE_LIMIT,
      },
    } : {}),
  };
}

function presentedDetail(entry: Entry, env: CapabilityEnv): ReturnType<typeof detailOf> {
  const detail = detailOf(entry);
  if (entry.id !== 'action.http' || !('example' in detail) || !detail.example || typeof detail.example !== 'object')
    return detail;
  const http = readHttpFixture(env);
  if (!http) return detail;
  const example = structuredClone(detail.example) as {steps?: Array<{with?: {fixture?: string}}>};
  if (example.steps?.[0]?.with) example.steps[0].with.fixture = http.fixture;
  return {...detail, example};
}

export function workflowCapabilities(env: CapabilityEnv, id?: string) {
  const connections = connectionSummary(env);
  if (id === undefined) return {
    query: 'overview' as const,
    definition: definitionContract(),
    capabilities: CATALOG.map(entry => entry.id === 'action.github.registered'
      ? {id: entry.id, kind: entry.kind, status: entry.status, summary: entry.summary, ...registeredCatalogFields()}
      : {id: entry.id, kind: entry.kind, status: entry.status, summary: entry.summary}),
    connections,
  };
  const entry = CATALOG.find(item => item.id === id);
  if (!entry) return {
    query: 'detail' as const,
    id,
    status: 'unknown' as const,
    summary: 'No capability is registered with this id.',
    connections,
  };
  return {query: 'detail' as const, ...presentedDetail(entry, env), connections};
}
