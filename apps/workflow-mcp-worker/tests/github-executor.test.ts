import { describe, expect, it, vi } from 'vitest';
import { decideDispatchSequence, dispatchGitHubExecutor, getGitHubRunFact, githubExecutorTrust } from '../src/github-executor.js';
import type { Env } from '../src/types.js';

const env = {
  GITHUB_ACTIONS_TOKEN: 'gh-token',
  GITHUB_REPOSITORY: 'lirtual/mcp-workers',
  GITHUB_REPOSITORY_ID: '1371085786',
  GITHUB_EXECUTOR_REF: 'main',
  GITHUB_EXECUTOR_WORKFLOW: 'workflow-executor.yml'
} as unknown as Env;

describe('GitHub executor dispatch', () => {
  it('sends only Attempt identity inputs and records returned workflow_run_id', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(
        'https://api.github.com/repos/lirtual/mcp-workers/actions/workflows/workflow-executor.yml/dispatches'
      );
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe('Bearer gh-token');
      expect(headers.get('X-GitHub-Api-Version')).toBe('2026-03-10');

      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toEqual({
        ref: 'main',
        inputs: {
          attempt_id: 'att_1',
          claim_nonce: 'nonce-1'
        }
      });
      expect(JSON.stringify(body)).not.toContain('gh-token');
      expect(JSON.stringify(body)).not.toContain('content');

      return Response.json({
        workflow_run_id: 9001,
        run_url: 'https://api.github.com/repos/lirtual/mcp-workers/actions/runs/9001',
        html_url: 'https://github.com/lirtual/mcp-workers/actions/runs/9001'
      });
    });

    await expect(
      dispatchGitHubExecutor(env, 'att_1', 'nonce-1', {
        generation: 2,
        fetchImpl: fetchImpl as typeof fetch
      })
    ).resolves.toEqual({
      generation: 2,
      outcome: 'accepted',
      workflowRunId: '9001',
      runUrl: 'https://api.github.com/repos/lirtual/mcp-workers/actions/runs/9001',
      htmlUrl: 'https://github.com/lirtual/mcp-workers/actions/runs/9001'
    });
  });

  it('classifies an explicit rejection as failed and transport ambiguity as unknown', async () => {
    const rejected = vi.fn(async () => new Response('no', { status: 403 }));
    await expect(
      dispatchGitHubExecutor(env, 'att_1', 'nonce', { fetchImpl: rejected as typeof fetch })
    ).resolves.toMatchObject({ outcome: 'failed' });

    const ambiguous = vi.fn(async () => {
      throw new TypeError('network reset');
    });
    await expect(
      dispatchGitHubExecutor(env, 'att_1', 'nonce', { fetchImpl: ambiguous as typeof fetch })
    ).resolves.toMatchObject({ outcome: 'unknown' });
  });

  it('redispatches only after ambiguity and preserves an earlier unknown Candidate', () => {
    expect(decideDispatchSequence([{ outcome: 'unknown' }], 2)).toBe('redispatch');
    expect(
      decideDispatchSequence([{ outcome: 'unknown' }, { outcome: 'accepted' }], 2)
    ).toBe('wait');
    expect(
      decideDispatchSequence([{ outcome: 'unknown' }, { outcome: 'failed' }], 2)
    ).toBe('wait');
    expect(decideDispatchSequence([{ outcome: 'failed' }], 2)).toBe('failed');
    expect(
      decideDispatchSequence([{ outcome: 'unknown' }, { outcome: 'unknown' }], 2)
    ).toBe('wait');
  });

  it('retrieves the bound GitHub run fact for timeout reconciliation', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(
        'https://api.github.com/repos/lirtual/mcp-workers/actions/runs/9001'
      );
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer gh-token');
      return Response.json({ status: 'completed', conclusion: 'failure' });
    });

    await expect(
      getGitHubRunFact(env, '9001', fetchImpl as typeof fetch)
    ).resolves.toEqual({
      runId: '9001',
      status: 'completed',
      conclusion: 'failure'
    });
  });

  it('derives the OIDC trust policy from server configuration', () => {
    expect(githubExecutorTrust(env)).toEqual({
      repositoryId: '1371085786',
      workflowRef:
        'lirtual/mcp-workers/.github/workflows/workflow-executor.yml@refs/heads/main',
      ref: 'refs/heads/main'
    });
  });
});
