export interface Env {
  MCP_ACCESS_TOKEN: string;
  ACTIONS_GITHUB_DISPATCH_TOKENS: string;
}

export class ActionError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WORKFLOW = /^(?:[1-9][0-9]*|[A-Za-z0-9_.-]+\.ya?ml)$/;
const MAX_RESPONSE_BYTES = 512 * 1024;
// Bound discovery rather than exhaust a large account's entire repository list.
// Failing closed is safer than treating truncated discovery as comprehensive.
const REPO_PAGE_SIZE = 25;
const MAX_REPO_PAGES = 8;
const MAX_GITHUB_TOKENS = 8;

/** One ACTIONS_GITHUB_DISPATCH_TOKENS Secret supports one PAT per line. Existing single-line values work unchanged. */
export function parseGithubTokens(value: string | undefined): string[] {
  if (!value || !value.trim()) throw new ActionError('github_token_not_configured');
  const tokens = value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  if (tokens.length < 1 || tokens.length > MAX_GITHUB_TOKENS ||
      tokens.some((token) => token.length > 512 || /\s/.test(token))) {
    throw new ActionError('invalid_github_tokens');
  }
  if (new Set(tokens).size !== tokens.length) throw new ActionError('duplicate_github_token');
  return tokens;
}

export function assertRepoName(repo: string): void {
  if (!REPOSITORY.test(repo) || repo.includes('..')) throw new ActionError('invalid_repository');
}

export function assertWorkflow(value: string): void {
  if (!WORKFLOW.test(value) || value === '.' || value === '..') throw new ActionError('invalid_workflow');
}

export function assertRunId(id: number): void {
  if (!Number.isSafeInteger(id) || id < 1) throw new ActionError('invalid_run_id');
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { throw new ActionError('invalid_upstream_json'); }
}

async function boundedJson(response: Response): Promise<any> {
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > MAX_RESPONSE_BYTES) throw new ActionError('upstream_response_too_large');
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new ActionError('upstream_response_too_large');
  return text ? parseJson(text) : {};
}

export class GitHubActionsClient {
  private readonly tokens: string[];
  private readonly requestFetch: typeof fetch;
  private repositoriesPromise?: Promise<Map<string, string | null>>;

  constructor(env: Env, requestFetch: typeof fetch = fetch) {
    this.tokens = parseGithubTokens(env.ACTIONS_GITHUB_DISPATCH_TOKENS);
    this.requestFetch = requestFetch;
  }

  private async authenticatedJson(url: string, token: string, init: RequestInit = {}): Promise<any> {
    const requestFetch = this.requestFetch;
    const response = await requestFetch(url, {
      ...init, redirect: 'manual',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'github-actions-mcp-worker',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    if (!response.ok) throw new ActionError('github_http_' + response.status);
    if (response.status === 204 || response.status === 202 ||
        (response.status === 201 && response.headers.get('content-length') === '0')) {
      return { accepted: true };
    }
    return boundedJson(response);
  }

  private async discoverRepositories(token: string): Promise<string[]> {
    const found = new Set<string>();
    for (let page = 1; page <= MAX_REPO_PAGES; page++) {
      const data = await this.authenticatedJson(
        'https://api.github.com/user/repos?per_page=' + REPO_PAGE_SIZE + '&page=' + page,
        token,
      );
      if (!Array.isArray(data) || data.length > REPO_PAGE_SIZE) {
        throw new ActionError('invalid_upstream_json');
      }
      for (const entry of data) {
        if (typeof entry?.full_name !== 'string') throw new ActionError('invalid_upstream_json');
        assertRepoName(entry.full_name);
        found.add(entry.full_name.toLowerCase());
      }
      if (data.length < REPO_PAGE_SIZE) return [...found];
    }
    throw new ActionError('repository_discovery_limit');
  }

  private async repoTokens(): Promise<Map<string, string | null>> {
    this.repositoriesPromise ??= (async () => {
      // Never retry failed discovery with another account or silently omit it.
      const lists = await Promise.all(this.tokens.map((token) => this.discoverRepositories(token)));
      const owners = new Map<string, string | null>();
      for (let i = 0; i < lists.length; i++) {
        for (const repo of lists[i]) {
          owners.set(repo, owners.has(repo) ? null : this.tokens[i]);
        }
      }
      return owners;
    })();
    return this.repositoriesPromise;
  }

  async listRepositories(): Promise<{ repositories: string[]; ambiguous_repositories: string[] }> {
    const owners = await this.repoTokens();
    return {
      repositories: [...owners].filter(([, token]) => token !== null).map(([repo]) => repo).sort(),
      ambiguous_repositories: [...owners].filter(([, token]) => token === null)
        .map(([repo]) => repo).sort(),
    };
  }

  async api(repo: string, path: string, init: RequestInit = {}): Promise<any> {
    assertRepoName(repo);
    const token = (await this.repoTokens()).get(repo.toLowerCase());
    if (token === null) throw new ActionError('ambiguous_repository_credentials');
    if (!token) throw new ActionError('repository_not_accessible');
    return this.authenticatedJson('https://api.github.com/repos/' + repo + '/' + path, token, init);
  }

  listWorkflows(repo: string) {
    return this.api(repo, 'actions/workflows?per_page=100').then((v) => ({
      total_count: v.total_count,
      workflows: (v.workflows ?? []).map((x: any) => ({
        id: x.id, name: x.name, path: x.path, state: x.state, html_url: x.html_url,
      })),
    }));
  }

  listRuns(repo: string, status?: string, workflow?: string) {
    if (workflow) assertWorkflow(workflow);
    const filter = status ? '&status=' + encodeURIComponent(status) : '';
    const path = workflow
      ? 'actions/workflows/' + encodeURIComponent(workflow) + '/runs?per_page=30' + filter
      : 'actions/runs?per_page=30' + filter;
    return this.api(repo, path).then((v) => ({
      total_count: v.total_count,
      runs: (v.workflow_runs ?? []).map(runView),
    }));
  }

  async getRun(repo: string, runId: number) {
    assertRunId(runId);
    return runView(await this.api(repo, 'actions/runs/' + runId));
  }

  async listJobs(repo: string, runId: number) {
    assertRunId(runId);
    const value = await this.api(repo, 'actions/runs/' + runId + '/jobs?per_page=100');
    return {
      total_count: value.total_count,
      jobs: (value.jobs ?? []).map((j: any) => ({
        id: j.id, name: j.name, status: j.status, conclusion: j.conclusion,
        started_at: j.started_at, completed_at: j.completed_at, html_url: j.html_url,
        steps: (j.steps ?? []).map((s: any) => ({
          name: s.name, status: s.status, conclusion: s.conclusion, number: s.number,
        })),
      })),
    };
  }

  async listArtifacts(repo: string, runId: number) {
    assertRunId(runId);
    const value = await this.api(repo, 'actions/runs/' + runId + '/artifacts?per_page=100');
    return {
      total_count: value.total_count,
      artifacts: (value.artifacts ?? []).map((a: any) => ({
        id: a.id, name: a.name, expired: a.expired, size_in_bytes: a.size_in_bytes,
        created_at: a.created_at, expires_at: a.expires_at,
      })),
    };
  }

  dispatchWorkflow(repo: string, workflow: string, ref: string, inputs: Record<string, string>) {
    assertWorkflow(workflow);
    if (!ref.trim() || ref.length > 200 || !/^[A-Za-z0-9_./-]+$/.test(ref) || ref.includes('..')) {
      throw new ActionError('invalid_ref');
    }
    return this.api(repo, 'actions/workflows/' + encodeURIComponent(workflow) + '/dispatches', {
      method: 'POST', body: JSON.stringify({ ref, inputs, return_run_details: true }),
    });
  }

  dispatchRepository(repo: string, eventType: string, payload: Record<string, unknown>) {
    if (!eventType || eventType.length > 100 || !/^[A-Za-z0-9_.-]+$/.test(eventType)) {
      throw new ActionError('invalid_event_type');
    }
    return this.api(repo, 'dispatches', {
      method: 'POST', body: JSON.stringify({ event_type: eventType, client_payload: payload }),
    });
  }

  async cancelRun(repo: string, runId: number) {
    assertRunId(runId);
    await this.api(repo, 'actions/runs/' + runId + '/cancel', { method: 'POST' });
    // HTTP 202 acknowledges the request; it does not prove the job has stopped.
    return { accepted: true, cancellation: 'requested', completion_confirmed: false, run_id: runId };
  }

  async forceCancelRun(repo: string, runId: number) {
    assertRunId(runId);
    await this.api(repo, 'actions/runs/' + runId + '/force-cancel', { method: 'POST' });
    // Force-cancel can bypass cleanup conditions; verify final status using getRun.
    return { accepted: true, cancellation: 'force_requested', completion_confirmed: false, run_id: runId };
  }

  rerunRun(repo: string, runId: number, failedOnly: boolean) {
    assertRunId(runId);
    return this.api(repo, 'actions/runs/' + runId + (failedOnly ? '/rerun-failed-jobs' : '/rerun'), { method: 'POST' });
  }
}

function runView(x: any) {
  return {
    id: x.id, workflow_id: x.workflow_id, name: x.name,
    display_title: x.display_title, event: x.event, head_branch: x.head_branch,
    status: x.status, conclusion: x.conclusion, run_attempt: x.run_attempt,
    html_url: x.html_url, created_at: x.created_at, updated_at: x.updated_at,
    run_started_at: x.run_started_at,
  };
}

