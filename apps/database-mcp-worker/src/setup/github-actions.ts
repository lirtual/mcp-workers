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
      method: 'POST', redirect: 'error',
      headers: {
        Authorization: 'Bearer ' + token,
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
    inputs.database_hyperdrive_enable_id = id;
    inputs.database_hyperdrive_enable_revision = String(revision);
  } else {
    inputs.database_hyperdrive_retire_approved = 'true';
    inputs.database_hyperdrive_retire_id = id;
    inputs.database_hyperdrive_retire_revision = String(revision);
  }
  return dispatchWorkflow(env, inputs, request);
}
