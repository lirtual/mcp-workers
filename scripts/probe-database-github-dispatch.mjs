#!/usr/bin/env node
// Existing release.yml gate: exercise the exact Owner Environment PAT before
// publishing Database Worker. This launches one no-deploy, no-approval run of
// the SAME workflow. It cannot recurse: deploy_to_production is false, and no
// Hyperdrive approval flags are passed. Never print the token or response.
import { pathToFileURL } from 'node:url';

const TARGET = 'https://api.github.com/repos/lirtual/mcp-workers/actions/workflows/release.yml/dispatches';

function forbiddenClass(message, permissions = '') {
  const m = typeof message === 'string' ? message.slice(0, 400) : '';
  if (/Resource not accessible by personal access token|Resource not accessible by integration/i.test(m))
    return 'token_missing_actions_write_or_repo_scope';
  if (/SAML|SSO|single sign.on/i.test(m)) return 'token_sso_authorization_required';
  if (/IP allow list|IP address|IP allowlist/i.test(m)) return 'token_ip_policy_rejected';
  if (/rate limit|abuse detection/i.test(m)) return 'github_rate_limited';
  if (/actions=write/i.test(permissions) && /required/i.test(m)) return 'github_org_policy_rejected';
  return 'github_forbidden_unclassified';
}

export function classifyGithubResponse(status, body, permissions = '') {
  if (status === 401) return 'token_invalid_or_expired';
  if (status === 403) return forbiddenClass(body?.message, permissions);
  if (status === 404) return 'repo_or_workflow_inaccessible';
  if (status === 422) return 'workflow_dispatch_inputs_rejected';
  if (status === 429) return 'github_rate_limited';
  if (status >= 300 && status < 400) return 'github_redirect_rejected';
  if (status >= 500) return 'github_upstream_unavailable';
  return 'github_http_rejected';
}

export async function checkOwnerDispatch(token, request = fetch) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 512 || /\s/.test(token))
    throw Error('database_actions_token_missing_or_invalid');
  let response;
  try {
    response = await request(TARGET, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: JSON.stringify({
        ref: 'main',
        return_run_details: true,
        inputs: { worker: 'database-mcp-worker', deploy_to_production: 'false' }
      }),
      signal: AbortSignal.timeout(15000)
    });
  } catch {
    // A network failure may occur *after* GitHub accepted the dispatch.
    // Never retry; inspect run history.
    throw Error('database_actions_dispatch_outcome_unknown');
  }
  if (response.status === 204) return { acknowledged: true };
  if (response.status === 200) {
    let parsed;
    try { parsed = await response.json(); }
    catch { throw Error('database_actions_dispatch_receipt_invalid'); }
    const run = parsed?.workflow_run_id;
    if (!Number.isSafeInteger(run) || run <= 0) throw Error('database_actions_dispatch_receipt_invalid');
    return { acknowledged: true, runId: run };
  }
  let body;
  try { body = await response.json(); } catch { body = null; }
  // Do not emit provider payloads, headers, credentials or arbitrary text.
  throw Error('database_actions_' + classifyGithubResponse(
    response.status, body, response.headers.get('x-accepted-github-permissions') ?? ''));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkOwnerDispatch(process.env.DATABASE_GITHUB_ACTIONS_TOKEN).then(result => {
    process.stdout.write('Database GitHub dispatch preflight: accepted' +
      (result.runId ? ' run=' + result.runId : '') + '\n');
  }).catch(error => {
    const msg = error instanceof Error ? error.message : '';
    const code = /^database_actions_[a-z0-9_]{3,80}$/.test(msg) ? msg : 'database_actions_unclassified';
    process.stderr.write('Database GitHub dispatch preflight: BLOCKED code=' + code + '\n');
    process.exitCode = 1;
  });
}
