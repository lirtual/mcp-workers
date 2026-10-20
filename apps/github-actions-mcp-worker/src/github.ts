export interface Env {
  MCP_ACCESS_TOKEN: string;
  GITHUB_TOKEN: string;
  GITHUB_REPOS: string;
  SESSION_DECK_URL?: string;
  SESSION_PASSWORD?: string;
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

export function configuredRepos(value: string | undefined): string[] {
  if (!value) return [];
  const repos = value.split(',').map((repo) => repo.trim()).filter(Boolean);
  if (repos.some((repo) => !REPOSITORY.test(repo) || repo.includes('..'))) {
    throw new ActionError('invalid_repository_configuration');
  }
  return [...new Set(repos)];
}

export function assertRepo(allowlist: string[], repo: string): void {
  if (!REPOSITORY.test(repo) || !allowlist.some((allowed) => allowed.toLowerCase() === repo.toLowerCase())) {
    throw new ActionError('repository_not_allowed');
  }
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
  readonly allowlist: string[];
  private readonly env: Env;
  private readonly requestFetch: typeof fetch;
  constructor(env: Env, requestFetch: typeof fetch = fetch) {
    this.env = env;
    this.requestFetch = requestFetch;
    this.allowlist = configuredRepos(env.GITHUB_REPOS);
  }

  async api(repo: string, path: string, init: RequestInit = {}): Promise<any> {
    assertRepo(this.allowlist, repo);
    if (!this.env.GITHUB_TOKEN) throw new ActionError('github_token_not_configured');
    const url = 'https://api.github.com/repos/' + repo + '/' + path;
    const response = await this.requestFetch(url, {
      ...init,
      redirect: 'manual',
      headers: {
        'Authorization': 'Bearer ' + this.env.GITHUB_TOKEN,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'github-actions-mcp-worker',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    if (!response.ok) {
      // Never put untrusted GitHub error bodies, header values, or tokens in MCP results.
      throw new ActionError('github_http_' + response.status);
    }
    if (response.status === 204 || response.status === 202 || response.status === 201 && response.headers.get('content-length') === '0') {
      return { accepted: true };
    }
    return boundedJson(response);
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
      method: 'POST', body: JSON.stringify({ ref, inputs }),
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

  cancelRun(repo: string, runId: number) {
    assertRunId(runId);
    return this.api(repo, 'actions/runs/' + runId + '/cancel', { method: 'POST' });
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

// Session Deck owns discovery, input validation, exclusive session transitions,
// locator artifacts, and decryption. This bridge does not duplicate that logic.
export class SessionDeckClient {
  private readonly baseUrl: string;
  private readonly env: Env;
  private readonly allowlist: string[];
  private readonly requestFetch: typeof fetch;
  constructor(env: Env, allowlist: string[], requestFetch: typeof fetch = fetch) {
    this.env = env;
    this.allowlist = allowlist;
    this.requestFetch = requestFetch;
    const raw = env.SESSION_DECK_URL;
    if (!raw || !env.SESSION_PASSWORD) throw new ActionError('session_deck_not_configured');
    let url: URL;
    try { url = new URL(raw); } catch { throw new ActionError('invalid_session_deck_url'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new ActionError('invalid_session_deck_url');
    }
    this.baseUrl = url.origin;
  }

  private async request(path: string, method = 'GET', input?: Record<string, unknown>): Promise<any> {
    const response = await this.requestFetch(this.baseUrl + '/api/targets' + path, {
      method, redirect: 'manual',
      headers: {
        Authorization: 'Bearer ' + this.env.SESSION_PASSWORD,
        Accept: 'application/json',
        ...(input ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(input ? { body: JSON.stringify(input) } : {}),
    });
    if (!response.ok) throw new ActionError('session_deck_http_' + response.status);
    return boundedJson(response);
  }

  private allowedTarget(target: any): boolean {
    return !!target && typeof target.repo === 'string' &&
      this.allowlist.some((repo) => repo.toLowerCase() === target.repo.toLowerCase());
  }

  private project(target: any, revealSensitive = false): any {
    const facts = Array.isArray(target.facts) ? target.facts : [];
    return {
      id: target.id, label: target.label, repo: target.repo, state: target.state,
      runUrl: target.runUrl, startedAt: target.startedAt, openedBy: target.openedBy,
      onCaption: target.onCaption, inputs: target.inputs,
      facts: facts.map((f: any) => ({
        label: f.label, sensitive: !!f.sensitive,
        value: f.sensitive && !revealSensitive ? '[redacted]' : f.value,
      })),
    };
  }

  async list() {
    const value = await this.request('');
    return { targets: (value.targets ?? []).filter((target: any) => this.allowedTarget(target))
      .map((target: any) => this.project(target)) };
  }

  async get(id: string, revealSensitive = false) {
    const target = await this.request('/' + targetPath(id));
    if (!this.allowedTarget(target)) throw new ActionError('target_not_allowed');
    return this.project(target, revealSensitive);
  }

  async change(id: string, action: 'start' | 'stop', inputs?: Record<string, unknown>) {
    // Validate ownership before mutation: the Session Deck may expose more repos than this MCP.
    await this.get(id);
    const target = await this.request('/' + targetPath(id) + '/' + action, 'POST', inputs ?? {});
    if (!this.allowedTarget(target)) throw new ActionError('target_not_allowed');
    return this.project(target);
  }
}

function targetPath(id: string): string {
  if (!/^[A-Za-z0-9_.\/-]+$/.test(id) || id.includes('..') || id.startsWith('/') || id.endsWith('/')) {
    throw new ActionError('invalid_target_id');
  }
  return id.split('/').map(encodeURIComponent).join('/');
}
