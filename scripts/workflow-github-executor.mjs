/** Resolve the one deployment-approved GitHub executor from its Repository Variable.
 * This is read-only and must run under the protected selected-Worker release.
 * Its result, not the unverified name, is the deployed runtime identity.
 */
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_RESPONSE_BYTES = 65_536;
const API = 'https://api.github.com';

export function validateExecutorRepository(value) {
  if (typeof value !== 'string' || value.length > 201 ||
      !repositoryPattern.test(value) || value.includes('..') ||
      value.split('/').some(part => part.startsWith('.') || part.endsWith('.'))) {
    throw Error('WORKFLOW_GITHUB_ACTION_REPOSITORY must be one owner/repo');
  }
  return value;
}

/** Canonical attested Worker binding; never accept release-state caller overrides. */
export function parseVerifiedExecutorIdentity(value) {
  let entry;
  try { entry = typeof value === 'string' ? JSON.parse(value) : value; }
  catch { throw Error('Workflow release executor identity invalid'); }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
      Object.keys(entry).sort().join(',') !== 'ciWorkflowId,repository,repositoryId' ||
      !positiveId(entry.repositoryId) || !positiveId(entry.ciWorkflowId))
    throw Error('Workflow release executor identity invalid');
  validateExecutorRepository(entry.repository);
  return {repository:entry.repository,repositoryId:entry.repositoryId,
    ciWorkflowId:entry.ciWorkflowId};
}

function positiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

async function request(path, token, http) {
  let response;
  try {
    response = await http(new Request(API + path, {
      redirect: 'manual',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: 'Bearer ' + token,
        'x-github-api-version': '2026-03-10',
        'user-agent': 'workflow-mcp-executor-release',
      },
    }));
  } catch {
    throw Error('GitHub executor identity unavailable');
  }
  if (response.status !== 200) throw Error('GitHub executor identity unavailable');
  let body;
  try {
    const text = await response.text();
    if (new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES)
      throw Error('oversized');
    body = JSON.parse(text);
  } catch {
    throw Error('GitHub executor identity response invalid');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw Error('GitHub executor identity response invalid');
  return body;
}

/** A GitHub API redirect, renamed repository, inactive CI, or private repo
 * without token read access is an authorization failure, never a fallback. */
export async function verifyWorkflowGitHubExecutor(repository, token, http=fetch) {
  const name = validateExecutorRepository(repository);
  if (typeof token !== 'string' || !token.trim() || token.length > 8192)
    throw Error('WORKFLOW_GITHUB_DISPATCH_TOKEN unavailable');
  const meta = await request('/repos/' + name, token, http);
  if (meta.full_name !== name || !positiveId(meta.id) ||
      meta.default_branch !== 'main')
    throw Error('GitHub executor name, ID or default branch mismatch');
  const ci = await request('/repos/' + name + '/actions/workflows/ci.yml', token, http);
  if (!positiveId(ci.id) || ci.path !== '.github/workflows/ci.yml' ||
      ci.state !== 'active')
    throw Error('GitHub executor CI workflow identity mismatch');
  return Object.freeze({repository: name, repositoryId: meta.id, ciWorkflowId: ci.id});
}


// Validation is invoked only by the environment-free reusable CI checks job.
if (process.argv[1]?.endsWith('/workflow-github-executor.mjs') &&
    process.argv[2]==='validate-source') {
  try { validateExecutorRepository(process.argv[3]); }
  catch { console.error('Repository-level Workflow executor source invalid'); process.exitCode=1; }
}
