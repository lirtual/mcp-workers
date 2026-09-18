import type { RemoteAttemptTrust } from './executor-protocol.js';
import type { Env } from './types.js';

export type GitHubDispatchOutcome = 'accepted' | 'unknown' | 'failed';

export interface GitHubDispatchResult {
  generation: number;
  outcome: GitHubDispatchOutcome;
  workflowRunId?: string;
  runUrl?: string;
  htmlUrl?: string;
  errorSummary?: string;
}

export type DispatchSequenceDecision = 'redispatch' | 'wait' | 'failed';

export function decideDispatchSequence(
  dispatches: readonly Pick<GitHubDispatchResult, 'outcome'>[],
  maxGenerations = 2
): DispatchSequenceDecision {
  const last = dispatches.at(-1);
  if (!last) return 'failed';
  if (last.outcome === 'accepted') return 'wait';
  if (last.outcome === 'failed') {
    return dispatches.some(item => item.outcome === 'unknown') ? 'wait' : 'failed';
  }
  return dispatches.length < maxGenerations ? 'redispatch' : 'wait';
}

export async function dispatchGitHubExecutor(
  env: Env,
  attemptId: string,
  claimNonce: string,
  options: { generation?: number; fetchImpl?: typeof fetch } = {}
): Promise<GitHubDispatchResult> {
  const generation = options.generation ?? 1;
  const repository = required(env.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY');
  const workflow = required(env.GITHUB_EXECUTOR_WORKFLOW, 'GITHUB_EXECUTOR_WORKFLOW');
  const ref = required(env.GITHUB_EXECUTOR_REF, 'GITHUB_EXECUTOR_REF');
  const token = required(env.GITHUB_ACTIONS_TOKEN, 'GITHUB_ACTIONS_TOKEN');
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint =
    `https://api.github.com/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2026-03-10',
        'User-Agent': 'workflow-mcp-worker'
      },
      body: JSON.stringify({
        ref,
        inputs: {
          attempt_id: attemptId,
          claim_nonce: claimNonce
        }
      })
    });
  } catch (error) {
    return {
      generation,
      outcome: 'unknown',
      errorSummary: safeMessage(error)
    };
  }

  if (!response.ok) {
    return {
      generation,
      outcome: 'failed',
      errorSummary: `GitHub workflow dispatch failed with status ${response.status}.`
    };
  }

  try {
    const body = (await response.json()) as {
      workflow_run_id?: string | number;
      run_url?: string;
      html_url?: string;
    };
    if (body.workflow_run_id === undefined) {
      return {
        generation,
        outcome: 'unknown',
        errorSummary: 'GitHub accepted workflow dispatch but did not return workflow_run_id.'
      };
    }
    return {
      generation,
      outcome: 'accepted',
      workflowRunId: String(body.workflow_run_id),
      ...(typeof body.run_url === 'string' ? { runUrl: body.run_url } : {}),
      ...(typeof body.html_url === 'string' ? { htmlUrl: body.html_url } : {})
    };
  } catch (error) {
    return {
      generation,
      outcome: 'unknown',
      errorSummary: `GitHub dispatch response could not be decoded: ${safeMessage(error)}`
    };
  }
}

export function githubExecutorTrust(env: Env): RemoteAttemptTrust {
  const repository = required(env.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY');
  const repositoryId = required(env.GITHUB_REPOSITORY_ID, 'GITHUB_REPOSITORY_ID');
  const workflow = required(env.GITHUB_EXECUTOR_WORKFLOW, 'GITHUB_EXECUTOR_WORKFLOW');
  const configuredRef = required(env.GITHUB_EXECUTOR_REF, 'GITHUB_EXECUTOR_REF');
  const ref = configuredRef.startsWith('refs/') ? configuredRef : `refs/heads/${configuredRef}`;

  return {
    repositoryId,
    workflowRef: `${repository}/.github/workflows/${workflow}@${ref}`,
    ref,
    ...(env.GITHUB_EXECUTOR_WORKFLOW_SHA
      ? { workflowSha: env.GITHUB_EXECUTOR_WORKFLOW_SHA }
      : {})
  };
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : 'Unknown GitHub dispatch error.').slice(0, 500);
}


export type GitHubCancelOutcome =
  | 'accepted'
  | 'already_terminal'
  | 'unknown'
  | 'failed';

export interface GitHubCancelResult {
  runId: string;
  outcome: GitHubCancelOutcome;
  errorSummary?: string;
}

export async function cancelGitHubRun(
  env: Env,
  runId: string,
  fetchImpl: typeof fetch = fetch
): Promise<GitHubCancelResult> {
  const repository = required(env.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY');
  const token = required(env.GITHUB_ACTIONS_TOKEN, 'GITHUB_ACTIONS_TOKEN');
  const endpoint =
    `https://api.github.com/repos/${repository}/actions/runs/${encodeURIComponent(runId)}/cancel`;

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2026-03-10',
        'User-Agent': 'workflow-mcp-worker'
      }
    });
  } catch (error) {
    return {
      runId,
      outcome: 'unknown',
      errorSummary: safeMessage(error)
    };
  }

  if (response.status === 202) {
    return { runId, outcome: 'accepted' };
  }

  if (response.status === 409) {
    try {
      const fact = await getGitHubRunFact(env, runId, fetchImpl);
      if (fact.status === 'completed') {
        return { runId, outcome: 'already_terminal' };
      }
    } catch (error) {
      return {
        runId,
        outcome: 'unknown',
        errorSummary: safeMessage(error)
      };
    }
  }

  return {
    runId,
    outcome: 'failed',
    errorSummary: `GitHub workflow cancellation failed with status ${response.status}.`
  };
}

export interface GitHubRunFact {
  runId: string;
  status: 'queued' | 'in_progress' | 'completed' | 'unknown';
  conclusion?: string;
}

export async function getGitHubRunFact(
  env: Env,
  runId: string,
  fetchImpl: typeof fetch = fetch
): Promise<GitHubRunFact> {
  const repository = required(env.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY');
  const token = required(env.GITHUB_ACTIONS_TOKEN, 'GITHUB_ACTIONS_TOKEN');
  const response = await fetchImpl(
    `https://api.github.com/repos/${repository}/actions/runs/${encodeURIComponent(runId)}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2026-03-10',
        'User-Agent': 'workflow-mcp-worker'
      }
    }
  );
  if (!response.ok) {
    throw new Error(`GitHub workflow run lookup failed with status ${response.status}.`);
  }
  const body = (await response.json()) as { status?: string; conclusion?: string | null };
  const status =
    body.status === 'queued' || body.status === 'in_progress' || body.status === 'completed'
      ? body.status
      : 'unknown';
  return {
    runId,
    status,
    ...(typeof body.conclusion === 'string' ? { conclusion: body.conclusion } : {})
  };
}
