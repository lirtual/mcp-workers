import type { Env } from '../types.js';
import { PublicError } from '../errors.js';

// Only dispatch the already protected Owner/main Release Worker workflow.
// The Worker never receives a Cloudflare management credential and never
// performs Hyperdrive or D1 mutation through this helper.
const WORKFLOW_URL = 'https://api.github.com/repos/lirtual/mcp-workers/actions/workflows/release.yml/dispatches';
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export async function dispatchHyperdriveAction(
  env: Env,
  action: 'enable' | 'retire',
  id: string,
  revision: number,
  request: typeof fetch = fetch
): Promise<void> {
  if ((action !== 'enable' && action !== 'retire') || !ID.test(id) ||
      !Number.isSafeInteger(revision) || revision < 1) {
    throw new PublicError('INVALID_INPUT', 'Invalid Hyperdrive action.');
  }
  const token = env.DATABASE_GITHUB_ACTIONS_TOKEN;
  if (typeof token !== 'string' || token.length < 20) {
    throw new PublicError('CONFIGURATION_UNAVAILABLE', 'Protected GitHub Actions dispatch is not configured.');
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
      body: JSON.stringify({ ref: 'main', inputs }),
      signal: AbortSignal.timeout(10000)
    });
  } catch {
    throw new PublicError('CONFIGURATION_UNAVAILABLE', 'Protected GitHub Actions dispatch is unavailable.');
  }
  // GitHub workflow_dispatch returns 204, not a completed run receipt.
  // Never imply activation/retirement has completed here.
  if (response.status !== 204) {
    throw new PublicError('CONFIGURATION_UNAVAILABLE', 'Protected GitHub Actions dispatch was not accepted.');
  }
}
