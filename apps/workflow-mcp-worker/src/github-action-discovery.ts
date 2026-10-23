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
  commitSha: string;
  token: string;
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
const reject = (code: string): never => { throw Error('github_discovery_' + code); };
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

/**
 * The caller must supply a server-side, explicitly approved repository identity
 * and exact reviewed revision. Untrusted MCP inputs must never build this grant.
 * Discovery reads GitHub data only; it never authorizes execution.
 */
export async function discoverGitHubActions(
  grant: RepositoryGrant,
  http: Http = fetch,
): Promise<GitHubActionSource[]> {
  if (!REPO.test(grant.repository) || grant.repository.includes('..') ||
      !Number.isSafeInteger(grant.repositoryId) || grant.repositoryId <= 0 ||
      !SHA.test(grant.commitSha) || !grant.token.trim()) reject('invalid_grant');
  const prefix = '/repos/' + grant.repository;
  const repository = await get(prefix, grant.token, http);
  if (required(repository, 'id') !== grant.repositoryId ||
      required(repository, 'full_name') !== grant.repository) reject('repository_mismatch');

  const commit = await get(prefix + '/commits/' + grant.commitSha, grant.token, http);
  if (required(commit, 'sha') !== grant.commitSha) reject('revision_mismatch');

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
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) continue;
      const contents = await get(prefix + '/contents/' + path + '?ref=' + grant.commitSha, grant.token, http);
      if (required(contents, 'path') !== path ||
          required(contents, 'encoding') !== 'base64' ||
          typeof required(contents, 'content') !== 'string') reject('invalid_contents');
      const encoded = (required(contents, 'content') as string).replace(/\s/g, '');
      if (encoded.length > 90_000 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(encoded)) reject('invalid_contents');
      // Workers support atob; UTF-8 decoding must reject malformed bytes.
      let yaml: string;
      try {
        const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
        yaml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch { reject('invalid_contents'); }
      try {
        output.push({ repository: grant.repository, repositoryId: grant.repositoryId,
          commitSha: grant.commitSha, workflowPath: path, workflowId: id,
          contract: parseGitHubAction(yaml!) });
      } catch {
        // Ordinary non-Action GitHub workflows must remain invisible.
      }
    }
    if (workflows.length < 100) return output;
    page += 1;
  }
  reject('workflow_limit');
}
