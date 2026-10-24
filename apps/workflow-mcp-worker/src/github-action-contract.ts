import { parseDocument, isMap } from 'yaml';

export type ActionInput = {
  type: 'string' | 'choice' | 'boolean' | 'number';
  required: boolean;
  description?: string;
  default?: string | boolean | number;
  options?: string[];
};
export type DiscoveredAction = {
  name: string;
  type: 'task' | 'session';
  inputs: Record<string, ActionInput>;
};

const RESERVED = new Set(['attempt_id', 'dispatch_id', 'capability_id']);
const allowedTypes = new Set(['string', 'choice', 'boolean', 'number']);
const own = (value: unknown, key: string): unknown =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key] : undefined;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const literal = (value: unknown): value is string =>
  typeof value === 'string' && !value.includes('${{');
function fail(reason: string): never { throw Error('github_action_' + reason); }

/** Parse the selected revision, not a default-branch copy. Never grants execution. */
export function parseGitHubAction(yaml: string): DiscoveredAction {
  if (new TextEncoder().encode(yaml).byteLength > 65536) fail('too_large');
  const doc = parseDocument(yaml, { uniqueKeys: true, strict: true, version: '1.2' });
  if (doc.errors.length || !isMap(doc.contents)) fail('invalid_yaml');
  const root = doc.toJS({ maxAliasCount: 0 }) as unknown;
  if (!record(root)) fail('invalid_yaml');
  const env = root.env;
  if (!record(env) || !literal(env.WORKFLOW_ACTION_TYPE) ||
      !['task', 'session'].includes(env.WORKFLOW_ACTION_TYPE)) fail('invalid_type');
  if (!record(root.on) || !record(root.on.workflow_dispatch)) fail('missing_dispatch');
  const triggers = Object.keys(root.on);
  if (triggers.length !== 1 || triggers[0] !== 'workflow_dispatch') fail('unsupported_trigger');
  if (!literal(root.name) || !root.name.trim() || root.name.length > 128) fail('invalid_name');
  if (!record(root.jobs) || Object.keys(root.jobs).length === 0) fail('missing_jobs');
  for (const job of Object.values(root.jobs)) {
    if (!record(job)) fail('invalid_job');
    if (own(job.env, 'WORKFLOW_ACTION_TYPE') !== undefined ||
        (record(job.steps) && own(job.steps, 'WORKFLOW_ACTION_TYPE') !== undefined)) fail('shadowed_type');
    if (Array.isArray(job.steps)) {
      for (const step of job.steps) {
        if (own(own(step, 'env'), 'WORKFLOW_ACTION_TYPE') !== undefined) fail('shadowed_type');
      }
    }
  }
  const declared = root.on.workflow_dispatch.inputs ?? {};
  if (!record(declared) || Object.keys(declared).length > 13) fail('invalid_inputs');
  // GitHub rejects dispatch inputs not declared in workflow_dispatch. The
  // three agent-owned identifiers must be declared but never exposed as
  // caller-controlled Action inputs or defaults.
  if([...RESERVED].some(name=>!Object.hasOwn(declared,name))) fail('missing_identity_inputs');
  const inputs: Record<string, ActionInput> = {};
  for (const [name, raw] of Object.entries(declared)) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name)) fail('reserved_input');
    if (RESERVED.has(name.toLowerCase())) {
      if (name!==name.toLowerCase() || !record(raw) ||
          raw.type!=='string' || raw.required!==true ||
          raw.default!==undefined || raw.options!==undefined)
        fail('reserved_input');
      if(raw.description!==undefined&&
         (!literal(raw.description)||raw.description.length>1024))
        fail('reserved_input');
      continue;
    }
    if (name.toLowerCase().startsWith('workflow_')) fail('reserved_input');
    if (!record(raw) || !allowedTypes.has(raw.type as string)) fail('invalid_input_type');
    if (raw.required !== undefined && typeof raw.required !== 'boolean') fail('invalid_required');
    if (raw.description !== undefined && (!literal(raw.description) || raw.description.length > 1024)) fail('invalid_description');
    const type = raw.type as ActionInput['type'];
    const input: ActionInput = { type, required: raw.required === true };
    if (typeof raw.description === 'string') input.description = raw.description;
    if (type === 'choice') {
      if (!Array.isArray(raw.options) || raw.options.length === 0 ||
          raw.options.some(x => !literal(x)) || new Set(raw.options).size !== raw.options.length) fail('invalid_choices');
      input.options = raw.options;
    } else if (raw.options !== undefined) fail('invalid_choices');
    if (raw.default !== undefined) {
      const value = raw.default;
      if ((type === 'boolean' && typeof value !== 'boolean') ||
          (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) ||
          ((type === 'string' || type === 'choice') && !literal(value)) ||
          (type === 'choice' && !input.options?.includes(value as string))) fail('invalid_default');
      input.default = value as string | boolean | number;
    }
    inputs[name] = input;
    if (Object.keys(inputs).length > 10) fail('invalid_inputs');
  }
  if (env.WORKFLOW_ACTION_TYPE === 'session') {
    // One physical Job owns Ready, Tailscale and cleanup. The Runner itself
    // must stop the session at or before 330 minutes FROM JOB START, not
    // depend on best-effort Worker polling or a second scheduling service.
    const jobs=Object.values(root.jobs);
    if (jobs.length!==1) fail('session_requires_one_job');
    const job=jobs[0];
    const timeout=own(job,'timeout-minutes');
    // 360-minute GitHub Job guard leaves time for first-step 330-minute
    // expiry, normal shutdown, and best-effort cleanup.
    if(timeout !== 360)fail('invalid_session_timeout');
    const duration=inputs.duration_minutes;
    if(!duration || duration.type!=='number' ||
       duration.required || !Number.isSafeInteger(duration.default) ||
       (duration.default as number)<1 || (duration.default as number)>330)
      fail('invalid_session_duration');
  }
  return { name: root.name, type: env.WORKFLOW_ACTION_TYPE as 'task' | 'session', inputs };
}
