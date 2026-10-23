import { PRODUCTION_PORTAL_ENDPOINT, TRUSTED_PORTAL_ENDPOINT } from './mcp-public-fetch.ts';
import { GITHUB_ASYNC_WAIT_MS } from './github-async.ts';
import { selectedGithubExecutor } from './github-dispatch.ts';

export const DEFINITION_KEYS = ['version', 'name', 'inputs', 'triggers', 'steps'] as const;
export const STEP_KEYS = ['id', 'uses', 'needs', 'if', 'with'] as const;
export const USES = ['result.emit', 'mcp.call', 'github.run'] as const;
export type SupportedUse = typeof USES[number];
export const WITH_KEYS: Record<SupportedUse, readonly string[]> = {
  'result.emit': ['data'],
  'mcp.call': ['endpoint', 'tool', 'scope', 'arguments', 'input_schema', 'output_schema'],
  'github.run': ['capability'],
};
export const GITHUB_CAPABILITY_ID = 'github.workflow.check';
export const MCP_SCOPE = 'read' as const;
export const CONDITION_OPS = ['ref', 'eq', 'ne', 'gt', 'lt', 'and', 'or', 'not'] as const;
export const CONDITION_VALUE_OPS = ['eq', 'ne', 'gt', 'lt', 'and', 'or', 'not'] as const;
export const RESERVED_EXPRESSION_KEYS = ['eval', 'javascript', 'script', 'code', 'shell', 'endpoint', 'url', 'command', 'function'] as const;
export const OBJECT_PROTOTYPE_KEYS = ['constructor', 'toString', 'toLocaleString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable'] as const;
export const STEP_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
export const TOOL_NAME = /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,127}$/;
export const WEBHOOK_TRIGGER_KEYS = ['id', 'type', 'source', 'event'] as const;
export const GITHUB_TRIGGER_KEYS = ['id', 'type', 'repository', 'events'] as const;
// Business triggers only. GitHub Action lifecycle events stay on the executor
// claim/callback routes and are not a second orchestrator.
export const GITHUB_TRIGGER_EVENTS = ['create', 'delete', 'issue_comment', 'issues', 'pull_request', 'push', 'release'] as const;
export const TRIGGER_SOURCE_ID = /^[a-z][a-z0-9-]{0,63}$/;
export const TRIGGER_EVENT_NAME = /^[a-z][a-z0-9_]{0,63}$/;
export const TRIGGER_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const LIMITS = {
  definitionBytes: 32 * 1024,
  minSteps: 1,
  maxSteps: 32,
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
  maxTriggers: 2,
  maxTriggerEvents: 8,
} as const;

export function isConfiguredSecret(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 16 && value.length <= 256 && !/[\r\n]/.test(value);
}

const PORTAL_ENDPOINTS: readonly string[] = [TRUSTED_PORTAL_ENDPOINT, PRODUCTION_PORTAL_ENDPOINT];

export function isSupportedUse(value: unknown): value is SupportedUse {
  return typeof value === 'string' && (USES as readonly string[]).includes(value);
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
const githubExample = {
  version: 1,
  name: 'GitHub check',
  steps: [
    {id: 'heavy', uses: 'github.run', with: {capability: GITHUB_CAPABILITY_ID}},
    {id: 'out', needs: ['heavy'], uses: 'result.emit', with: {data: {ref: 'steps.heavy.output'}}},
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

type Kind = 'trigger' | 'action' | 'flow';
type SupportedEntry = {
  id: string;
  kind: Kind;
  status: 'supported';
  summary: string;
  example: unknown;
  uses?: SupportedUse;
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
  {id: 'trigger.cron', kind: 'trigger', status: 'unsupported',
    summary: 'Cron triggers are not implemented. Do not add a cron or schedule field.'},
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
  {id: 'action.mcp.call', kind: 'action', status: 'supported', uses: 'mcp.call', example: mcpExample,
    summary: 'Call one read-only MCP tool through the configured portal after publish-time approval.',
    permissions: 'scope must be read. Publish requires approved_operations exactly matching endpoint, tool, scope, and schema_digest, plus accept_target_risks=true. The endpoint must be the configured portal. A public URL shape is not authorization. Do not set schema_digest; the compiler adds it.',
    completion: 'One tools/call after grants and a live read-only schema check. A lost response is indeterminate and is not retried.'},
  {id: 'action.github.run', kind: 'action', status: 'supported', uses: 'github.run', example: githubExample,
    summary: 'Run the registered GitHub Workflow CI check. The definition cannot choose a repository, ref, workflow file, token, or command.',
    permissions: 'Publish requires approve_heavy_execution=true. Runtime uses the server GitHub executor and OIDC. with accepts only capability github.workflow.check.',
    completion: 'Dispatch accepted stores the GitHub run id on the Attempt. The step stays pending until one claimed receipt or the explicit '+String(GITHUB_ASYNC_WAIT_MS/1000)+' second wait ends. That receipt is the external terminal result. Lost, duplicate, early, and late wakes are not a second result. Worker recovery keeps the same Attempt. An ambiguous dispatch or timeout is indeterminate and is not dispatched again.'},
  {id: 'action.http', kind: 'action', status: 'unsupported',
    summary: 'HTTP actions are not implemented.'},
  {id: 'action.mcp.write', kind: 'action', status: 'unsupported',
    summary: 'MCP write scope is not implemented. mcp.call accepts only read.'},
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
  {id: 'flow.foreach', kind: 'flow', status: 'unsupported',
    summary: 'foreach is not implemented. Do not add a foreach field.'},
  {id: 'flow.while', kind: 'flow', status: 'unsupported',
    summary: 'while and until loops are not implemented. Do not add a while field.'},
  {id: 'flow.child_workflow', kind: 'flow', status: 'unsupported',
    summary: 'Child workflows are not implemented.'},
  {id: 'flow.saga', kind: 'flow', status: 'unsupported',
    summary: 'Saga compensation is not implemented. Do not add a saga field.'},
];

export const supportedCapabilityExamples: readonly unknown[] = CATALOG.flatMap(entry =>
  entry.status === 'supported' ? [entry.example] : []);

export function capabilityCatalog(): ReadonlyArray<{id: string; kind: Kind; status: 'supported' | 'unsupported'; summary: string}> {
  return CATALOG.map(({id, kind, status, summary}) => ({id, kind, status, summary}));
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
};

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
    ? {status: 'configured' as const, endpoint: portal, scope: MCP_SCOPE,
      publish: 'approved_operations must match endpoint, tool, scope, and schema_digest, and accept_target_risks must be true'}
    : {status: 'unavailable' as const};
  const githubReady = Boolean(env.WORKFLOW_EXECUTOR_GITHUB_TOKEN && env.GITHUB_EXECUTOR_REPOSITORY &&
    env.GITHUB_EXECUTOR_REPOSITORY_ID && env.GITHUB_EXECUTOR_REF && env.GITHUB_EXECUTOR_AUDIENCE);
  const triggers = triggerConnections(env);
  if (!githubReady) return {mcp_portal, github_executor: {status: 'unavailable' as const}, ...triggers};
  try {
    const workflow = selectedGithubExecutor(env).workflow;
    return {mcp_portal, github_executor: {
      status: 'configured' as const,
      repository: env.GITHUB_EXECUTOR_REPOSITORY,
      ref: env.GITHUB_EXECUTOR_REF,
      workflow,
      audience: env.GITHUB_EXECUTOR_AUDIENCE,
    }, ...triggers};
  } catch {
    return {mcp_portal, github_executor: {status: 'unavailable' as const}, ...triggers};
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
      max_inputs: LIMITS.maxInputs,
      max_name_length: LIMITS.maxNameLength,
      max_expression_depth: LIMITS.maxExpressionDepth,
      max_expression_array: LIMITS.maxArrayLength,
      max_tool_schema_bytes: LIMITS.maxToolSchemaBytes,
      max_triggers: LIMITS.maxTriggers,
    },
    manual_start: 'Call workflow_run after explicit publish. Omit triggers for a manual-only definition. Typed input checks are unsupported.',
    event_admission: 'Webhook and GitHub event deliveries admit through the same Run path as workflow_run. A stable event id dedupes to one Run of the version active at first admission. A missing stable event id does not promise exactly-once. Cron is unsupported.',
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
          description: 'Optional. At most one webhook and one github_event.',
        },
        steps: {
          type: 'array', minItems: LIMITS.minSteps, maxItems: LIMITS.maxSteps,
          items: {type: 'object', required: ['id', 'uses', 'with'], properties: {id: {type: 'string'}, uses: {enum: USES}}},
        },
      },
    },
  };
}
function stepSchema(uses: SupportedUse) {
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
      with: {
        type: 'object',
        additionalProperties: false,
        required: uses === 'mcp.call' ? ['endpoint', 'tool', 'scope', 'arguments', 'input_schema'] : [...withKeys],
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
    schema: stepSchema(entry.uses),
    ...(entry.uses === 'github.run' ? {capability: GITHUB_CAPABILITY_ID} : {}),
    ...(entry.uses === 'mcp.call' ? {scope: MCP_SCOPE} : {}),
  } : {schema: definitionContract().schema};
  return {...base, ...action, permissions: entry.permissions, completion: entry.completion, example: entry.example,
    ...(entry.id === 'flow.parallel' ? {limits: {max_parallel_steps: LIMITS.maxParallel}} : {}),
    ...(entry.id === 'flow.if' ? {condition_ops: CONDITION_OPS} : {}),
  };
}

export function workflowCapabilities(env: CapabilityEnv, id?: string) {
  const connections = connectionSummary(env);
  if (id === undefined) return {
    query: 'overview' as const,
    definition: definitionContract(),
    capabilities: CATALOG.map(({id: capabilityId, kind, status, summary}) => ({id: capabilityId, kind, status, summary})),
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
  return {query: 'detail' as const, ...detailOf(entry), connections};
}
