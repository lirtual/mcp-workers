import { parseGitHubAction, type DiscoveredAction } from './github-action-contract.ts';

export type GitHubActionSource = {
  repository: string;
  repositoryId: number;
  commitSha: string;
  workflowPath: string;
  workflowId: number;
  contract: DiscoveredAction;
};

type RepositoryGrant = {
  repository: string;
  repositoryId: number;
  commitSha?: string;
  token: string;
  workflowId?: number;
  workflowPath?: string;
};
type Http = (request: Request) => Promise<Response>;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[a-f0-9]{40}$/i;
const WORKFLOW = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/;
const api = 'https://api.github.com';
const headers = (token: string) => ({
  accept: 'application/vnd.github+json',
  authorization: 'Bearer ' + token,
  'x-github-api-version': '2026-03-10',
  'user-agent': 'workflow-mcp-action-discovery',
});
function reject(code: string): never { throw Error('github_discovery_' + code); }
async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) reject('github_unavailable');
  const text = await response.text();
  if (text.length > 256 * 1024) reject('oversized_response');
  try { return JSON.parse(text); } catch { return reject('invalid_response'); }
}
function object(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}
function required(x: unknown, property: string): unknown {
  return object(x) ? x[property] : undefined;
}
async function get(path: string, token: string, http: Http): Promise<unknown> {
  const response = await http(new Request(api + path, { headers: headers(token), redirect: 'manual' }));
  return readJson(response);
}
async function readWorkflow(
  prefix: string, path: string, id: number, commitSha: string, grant: RepositoryGrant, http: Http,
): Promise<GitHubActionSource | undefined> {
  const contents = await get(prefix + '/contents/' + path + '?ref=' + commitSha, grant.token, http);
  if (required(contents, 'path') !== path ||
      required(contents, 'encoding') !== 'base64' ||
      typeof required(contents, 'content') !== 'string') reject('invalid_contents');
  const encoded = (required(contents, 'content') as string).replace(/\s/g, '');
  if (encoded.length > 90_000 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(encoded)) reject('invalid_contents');
  let yaml: string;
  try {
    const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    yaml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { reject('invalid_contents'); }
  try {
    return { repository: grant.repository, repositoryId: grant.repositoryId,
      commitSha, workflowPath: path, workflowId: id, contract: parseGitHubAction(yaml!) };
  } catch {
    return undefined;
  }
}

/**
 * The caller must supply a server-side, explicitly approved repository identity
 * repository identity. Explicit SHA inputs are for pinned revalidation only;
 * never build the grant from untrusted MCP arguments.
 * Discovery reads GitHub data only; it never authorizes execution.
 */
export async function discoverGitHubActions(
  grant: RepositoryGrant,
  http: Http = fetch,
): Promise<GitHubActionSource[]> {
  const pinned = grant.workflowId !== undefined || grant.workflowPath !== undefined;
  if (!REPO.test(grant.repository) || grant.repository.includes('..') ||
      !Number.isSafeInteger(grant.repositoryId) || grant.repositoryId <= 0 ||
      (grant.commitSha !== undefined && !SHA.test(grant.commitSha)) ||
      !grant.token.trim() ||
      (pinned && (grant.commitSha === undefined || grant.workflowId === undefined ||
        grant.workflowPath === undefined || !Number.isSafeInteger(grant.workflowId) ||
        grant.workflowId <= 0 || !WORKFLOW.test(grant.workflowPath)))) reject('invalid_grant');
  const prefix = '/repos/' + grant.repository;
  const repository = await get(prefix, grant.token, http);
  if (required(repository, 'id') !== grant.repositoryId ||
      required(repository, 'full_name') !== grant.repository) reject('repository_mismatch');

  // Resolve the current default branch for discovery, then pin EVERY YAML
  // read to its exact returned SHA. The Published Plan retains its own
  // explicitly reviewed immutable SHA; discovery never grants execution.
  const branch = required(repository, 'default_branch');
  if (grant.commitSha === undefined &&
      (typeof branch !== 'string' || !/^[A-Za-z0-9_.\\/-]{1,200}$/.test(branch) ||
       branch.includes('..') || branch.startsWith('/') || branch.endsWith('/')))
    reject('invalid_default_branch');
  const commit = await get(prefix + '/commits/' +
    encodeURIComponent(grant.commitSha ?? (branch as string)), grant.token, http);
  const commitSha = required(commit, 'sha');
  if (typeof commitSha !== 'string' || !SHA.test(commitSha) ||
      (grant.commitSha !== undefined && commitSha !== grant.commitSha))
    reject('revision_mismatch');

  // A Publish recheck already knows the reviewed workflow. Read that file
  // only; listing every workflow again trips GitHub after the catalog scan.
  if (pinned) {
    const workflow = await get(prefix + '/actions/workflows/' + grant.workflowId, grant.token, http);
    if (required(workflow, 'id') !== grant.workflowId ||
        required(workflow, 'path') !== grant.workflowPath ||
        required(workflow, 'state') !== 'active') return [];
    const source = await readWorkflow(prefix, grant.workflowPath!, grant.workflowId!, commitSha, grant, http);
    return source ? [source] : [];
  }

  const output: GitHubActionSource[] = [];
  let page = 1;
  // Bounded paging prevents unexpected API or repository growth from
  // scanning an unapproved/oversized collection.
  while (page <= 10) {
    const found = await get(prefix + '/actions/workflows?per_page=100&page=' + page, grant.token, http);
    const workflows = required(found, 'workflows');
    if (!Array.isArray(workflows)) reject('invalid_workflow_list');
    for (const workflow of workflows) {
      const path = required(workflow, 'path');
      const id = required(workflow, 'id');
      if (typeof path !== 'string' || !WORKFLOW.test(path)) continue;
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 ||
          required(workflow, 'state') !== 'active') continue;
      const source = await readWorkflow(prefix, path, id, commitSha, grant, http);
      if (source) output.push(source);
    }
    if (workflows.length < 100) return output;
    page += 1;
  }
  reject('workflow_limit');
}
