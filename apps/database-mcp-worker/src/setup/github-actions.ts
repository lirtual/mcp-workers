import type { Env } from '../types.js';
import { PublicError } from '../errors.js';

// Only dispatch the already protected Owner/main Release Worker workflow.
// The Worker never receives a Cloudflare management credential and never
// performs Hyperdrive or D1 mutation through this helper.
const WORKFLOW_URL = 'https://api.github.com/repos/lirtual/mcp-workers/actions/workflows/release.yml/dispatches';
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export type DispatchReceipt = { runId?: number };
// Every diagnostic below is an allowlisted, bounded status class. No GitHub
// body, token, URL, input, or raw network exception is reflected to the Owner.
function rejectedStatus(status: number): string {
  if (status === 401) return 'GitHub Actions dispatch unauthorized.';
  if (status === 403) return 'GitHub Actions dispatch forbidden.';
  if (status === 404) return 'GitHub Actions workflow unavailable.';
  if (status === 422) return 'GitHub Actions dispatch inputs rejected.';
  if (status === 429) return 'GitHub Actions dispatch rate limited.';
  if (status >= 300 && status < 400) return 'GitHub Actions dispatch redirect rejected.';
  if (status >= 500 && status <= 599) return 'GitHub Actions dispatch upstream unavailable.';
  return 'GitHub Actions dispatch HTTP rejected.';
}

async function dispatchWorkflow(
  env: Env,
  inputs: Record<string, string>,
  request: typeof fetch
): Promise<DispatchReceipt> {
  const token = env.DATABASE_GITHUB_ACTIONS_TOKEN;
  if (typeof token !== 'string' || token.length < 20) {
    throw new PublicError('CONFIGURATION_UNAVAILABLE', 'Protected GitHub Actions dispatch is not configured.');
  }
  let response: Response;
  try {
    response = await request(WORKFLOW_URL, {
      // Cloudflare Workers does not implement Fetch redirect: 'error'; that
      // throws before network I/O and used to cause github_outcome_unknown.
      // 'manual' prevents following 3xx redirects with the Owner PAT.
      method: 'POST', redirect: 'manual',
      headers: {
        Authorization: 'Bearer ' + token,
        // GitHub REST rejects absent/invalid User-Agent (HTTP 403); Node
        // mocks default one, but Cloudflare Workers outbound fetch may not.
        'User-Agent': 'lirtual-database-mcp-worker',
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: JSON.stringify({ ref: 'main', inputs, return_run_details: true }),
      signal: AbortSignal.timeout(10000)
    });
  } catch {
    // The request might have reached GitHub before the connection failed.
    // Never retry automatically; check Actions run history first.
    throw new PublicError('CONFIGURATION_UNAVAILABLE', 'GitHub Actions dispatch outcome unknown.');
  }
  // GitHub accepts either 204 (legacy, no receipt) or 200 (run details).
  // A 200 must have a valid run id; never reflect untrusted provider content.
  if (response.status === 204) return {};
  if (response.status === 200) {
    let id: unknown;
    try {
      const result = await response.json() as { workflow_run_id?: unknown };
      id = result?.workflow_run_id;
    } catch {
      throw new PublicError('CONFIGURATION_UNAVAILABLE', 'GitHub Actions dispatch receipt unavailable.');
    }
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
      throw new PublicError('CONFIGURATION_UNAVAILABLE', 'GitHub Actions dispatch receipt unavailable.');
    }
    return { runId: id };
  }
  throw new PublicError('CONFIGURATION_UNAVAILABLE', rejectedStatus(response.status));
}

/**
 * Non-destructive Owner smoke: dispatch Release Worker on main with every
 * operation flag false. All existing release.yml jobs stay skipped; no D1,
 * database, Hyperdrive or Worker release mutation is requested.
 * HTTP 204 proves only GitHub accepted this request, not a completed run.
 */
export async function verifyGithubActionsDispatch(
  env: Env,
  request: typeof fetch = fetch
): Promise<DispatchReceipt> {
  return dispatchWorkflow(env, {
    worker: 'database-mcp-worker',
    deploy_to_production: 'false'
  }, request);
}

export async function dispatchHyperdriveAction(
  env: Env,
  action: 'enable' | 'retire',
  id: string,
  revision: number,
  request: typeof fetch = fetch
): Promise<DispatchReceipt> {
  if ((action !== 'enable' && action !== 'retire') || !ID.test(id) ||
      !Number.isSafeInteger(revision) || revision < 1) {
    throw new PublicError('INVALID_INPUT', 'Invalid Hyperdrive action.');
  }
  const inputs: Record<string, string> = {
    worker: 'database-mcp-worker',
    deploy_to_production: 'false'
  };
  if (action === 'enable') {
    inputs.database_hyperdrive_enable_approved = 'true';
    inputs.database_hyperdrive_id = id;
    inputs.database_hyperdrive_revision = String(revision);
  } else {
    inputs.database_hyperdrive_retire_approved = 'true';
    inputs.database_hyperdrive_id = id;
    inputs.database_hyperdrive_revision = String(revision);
  }
  return dispatchWorkflow(env, inputs, request);
}

/** Owner-only read-only check. Sends no password, CA PEM, or write approval. */
export async function dispatchHyperdriveRotationCheck(
  env: Env, mode: 'credentials' | 'ca', id: string, revision: number,
  request: typeof fetch = fetch
): Promise<DispatchReceipt> {
  if ((mode !== 'credentials' && mode !== 'ca') || !ID.test(id) ||
      !Number.isSafeInteger(revision) || revision < 1) {
    throw new PublicError('INVALID_INPUT', 'Invalid Hyperdrive rotation check.');
  }
  return dispatchWorkflow(env, {
    worker: 'database-mcp-worker', deploy_to_production: 'false',
    database_hyperdrive_rotation_mode: mode, database_hyperdrive_id: id,
    database_hyperdrive_revision: String(revision)
  }, request);
}

/** Only a bounded operation ID crosses into protected Actions; origin secrets remain encrypted in D1. */
export async function dispatchHyperdrivePrepare(
  env: Env, operationId: string, request: typeof fetch = fetch
): Promise<DispatchReceipt> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(operationId)) {
    throw new PublicError('INVALID_INPUT', 'Invalid Hyperdrive operation ID.');
  }
  return dispatchWorkflow(env, {
    worker: 'database-mcp-worker',
    deploy_to_production: 'false',
    database_hyperdrive_prepare_id: operationId
  }, request);
}

/** Read-only Owner preflight before reserving D1 or dispatching any external mutation. */
export async function verifyGithubPrCapability(
  env: Env, request: typeof fetch = fetch
): Promise<void> {
  const token = env.DATABASE_GITHUB_ACTIONS_TOKEN;
  if (typeof token !== 'string' || token.length < 20) {
    throw new PublicError('CONFIGURATION_UNAVAILABLE', 'Protected GitHub Actions dispatch is not configured.');
  }
  let response: Response;
  try {
    response = await request('https://api.github.com/repos/lirtual/mcp-workers/actions/permissions/workflow', {
      method: 'GET', redirect: 'manual', headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'lirtual-database-mcp-worker',
        'X-GitHub-Api-Version': '2022-11-28'
      }, signal: AbortSignal.timeout(10000)
    });
  } catch {
    throw new PublicError('CONFIGURATION_UNAVAILABLE', 'GitHub PR permissions could not be verified.');
  }
  if (response.status !== 200) {
    throw new PublicError('CONFIGURATION_UNAVAILABLE', 'GitHub PR permissions could not be verified.');
  }
  let enabled: unknown;
  try {
    enabled = ((await response.json()) as {can_approve_pull_request_reviews?: unknown})
      .can_approve_pull_request_reviews;
  } catch {
    throw new PublicError('CONFIGURATION_UNAVAILABLE', 'GitHub PR permissions could not be verified.');
  }
  if (enabled !== true) {
    throw new PublicError('CONFIGURATION_UNAVAILABLE', 'GitHub Actions PR creation is disabled.');
  }
  await verifyGithubRequiredChecks(env, request);
}

/** A classic 404 permits the no-protection path only after separately checking inherited rulesets. */
export async function verifyGithubRequiredChecks(env: Env, request: typeof fetch = fetch): Promise<void> {
  const headers = {
    Authorization: 'Bearer ' + env.DATABASE_GITHUB_ACTIONS_TOKEN,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'lirtual-database-mcp-worker',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  try {
    const classic = await request('https://api.github.com/repos/lirtual/mcp-workers/branches/main/protection', {
      method: 'GET', redirect: 'manual', headers, signal: AbortSignal.timeout(10000)
    });
    if (classic.status === 200) {
      const policy = await classic.json() as {required_status_checks?: {strict?: unknown; contexts?: unknown}};
      if (policy.required_status_checks?.strict === true &&
        Array.isArray(policy.required_status_checks.contexts) &&
        policy.required_status_checks.contexts.includes('Required checks gate')) return;
      throw Error('unconfirmed classic PR checks');
    }
    if (classic.status !== 404) throw Error('classic protection unknown');
    // The alternative is an explicitly unprotected main, not a substitute
    // for mandatory checks. Unknown/inherited rulesets must fail closed.
    const rules = await request('https://api.github.com/repos/lirtual/mcp-workers/rulesets?includes_parents=true&per_page=100', {
      method: 'GET', redirect: 'manual', headers, signal: AbortSignal.timeout(10000)
    });
    if (rules.status !== 200) throw Error('rulesets unavailable');
    const inventory: unknown = await rules.json();
    if (!Array.isArray(inventory) || inventory.length !== 0) throw Error('rulesets unknown or present');
  } catch {
    throw new PublicError('CONFIGURATION_UNAVAILABLE', 'GitHub required PR checks could not be verified.');
  }
}

/** Final apply dispatch carries only the immutable operation UUID. */
export async function dispatchHyperdriveApply(
  env: Env, operationId: string, request: typeof fetch = fetch
): Promise<DispatchReceipt> {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(operationId)) {
    throw new PublicError('INVALID_INPUT', 'Invalid Hyperdrive operation ID.');
  }
  return dispatchWorkflow(env, {
    worker: 'database-mcp-worker', deploy_to_production: 'false',
    database_hyperdrive_apply_id: operationId
  }, request);
}

/** Read-only Owner lookup for the exact #476 unbinding branch. PR metadata is
 * status evidence, never approval to merge, publish or retire any resource. */
export async function readHyperdriveUnbindStatus(
  env: Env, id: string, request: typeof fetch = fetch
): Promise<{phase:'not_staged'|'draft_review'|'review_available'|'merged_unpublished'|'closed_unmerged';prNumber?:number}> {
  if (!ID.test(id)) throw new PublicError('INVALID_INPUT', 'Invalid Hyperdrive connection ID.');
  const token = env.DATABASE_GITHUB_ACTIONS_TOKEN;
  if (typeof token !== 'string' || token.length < 20) {
    throw new PublicError('CONFIGURATION_UNAVAILABLE', 'Protected GitHub Actions dispatch is not configured.');
  }
  const bytes = new TextEncoder().encode('db476:unbind:' + id);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    .map(x => x.toString(16).padStart(2,'0')).join('').slice(0,24);
  const branch = 'db476-unbind-' + hash;
  const base = 'https://api.github.com/repos/lirtual/mcp-workers';
  const blocked = () => new PublicError('CONFIGURATION_UNAVAILABLE', 'Hyperdrive unbinding status could not be verified.');
  async function get(path:string): Promise<unknown> {
    let response:Response;
    try {
      response = await request(base + path, {method:'GET',redirect:'manual',
        headers: { Authorization:'Bearer '+token, Accept:'application/vnd.github+json',
          'User-Agent':'lirtual-database-mcp-worker','X-GitHub-Api-Version':'2022-11-28' },
        signal:AbortSignal.timeout(10_000)});
    } catch { throw blocked(); }
    if (response.status!==200) throw blocked();
    try {return await response.json();} catch {throw blocked();}
  }
  const found = await get('/pulls?state=all&head=lirtual%3A'+branch+'&per_page=100');
  if (!Array.isArray(found) || found.length>1) throw blocked();
  if (found.length===0) return {phase:'not_staged'};
  const number = (found[0] as {number?:unknown}).number;
  if (!Number.isSafeInteger(number) || (number as number)<1) throw blocked();
  const pr = await get('/pulls/'+number) as {
    number?:number;state?:string;draft?:boolean;merged_at?:unknown;changed_files?:number;
    head?:{ref?:string;repo?:{full_name?:string}};
    base?:{ref?:string;repo?:{full_name?:string}};
  };
  if (pr?.number!==number || pr.head?.ref!==branch ||
      pr.head.repo?.full_name!=='lirtual/mcp-workers' ||
      pr.base?.ref!=='main' || pr.base.repo?.full_name!=='lirtual/mcp-workers' ||
      pr.changed_files!==2 || !['open','closed'].includes(pr.state??'') ||
      typeof pr.draft!=='boolean') throw blocked();
  const files = await get('/pulls/'+number+'/files?per_page=100');
  if (!Array.isArray(files) || files.length!==2 ||
      !['apps/database-mcp-worker/wrangler.jsonc',
        'apps/database-mcp-worker/hyperdrive-bindings.json'].every(path=>
        files.filter((f:unknown)=>typeof f==='object' && f!==null &&
          (f as {filename?:string}).filename===path &&
          (f as {status?:string}).status==='modified').length===1)) throw blocked();
  let phase:'draft_review'|'review_available'|'merged_unpublished'|'closed_unmerged';
  if (pr.state==='open') {
    if (pr.merged_at!=null) throw blocked();
    phase=pr.draft?'draft_review':'review_available';
  } else {
    phase=pr.merged_at==null?'closed_unmerged':'merged_unpublished';
  }
  return {phase,prNumber:number as number};
}
