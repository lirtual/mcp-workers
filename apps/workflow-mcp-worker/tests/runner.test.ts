import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  executeRegisteredCapability,
  runExecutor
} from '../runner/run.js';

describe('checked-in GitHub runner', () => {
  it('executes only the registered archive capability and emits metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workflow-runner-'));
    const output = await executeRegisteredCapability(
      {
        version: 1,
        runId: 'run_1',
        stepRunId: 'step_1',
        attemptId: 'att_1',
        operationId: 'op_1',
        capability: 'github.archive_markdown',
        input: {
          content: '# hello',
          source_url: 'https://example.com/'
        }
      },
      { RUNNER_TEMP: dir }
    );

    expect(output.artifact).toMatchObject({
      name: 'archive.md',
      mediaType: 'text/markdown',
      size: 7,
      sourceUrl: 'https://example.com/'
    });
    expect((output.artifact as Record<string, unknown>).sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(readFile(join(dir, 'archive.md'), 'utf8')).resolves.toBe('# hello');

    await expect(
      executeRegisteredCapability(
        {
          version: 1,
          runId: 'run_1',
          stepRunId: 'step_1',
          attemptId: 'att_1',
          operationId: 'op_1',
          capability: 'github.shell',
          input: {}
        },
        { RUNNER_TEMP: dir }
      )
    ).rejects.toThrow(/Unregistered GitHub capability/);
  });

  it('exits cleanly without fetching a manifest when Candidate Job loses Claim', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith('https://oidc.example/token')) {
        return Response.json({ value: 'oidc-token' });
      }
      if (url.endsWith('/executor/claim')) {
        return Response.json(
          { error: { code: 'ATTEMPT_CLAIM_REJECTED', message: 'lost' } },
          { status: 409 }
        );
      }
      throw new Error(`unexpected request ${url}`);
    });

    await expect(
      runExecutor(
        {
          ATTEMPT_ID: 'att_1',
          CLAIM_NONCE: 'nonce',
          WORKFLOW_MCP_URL: 'https://workflow.example',
          ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example/token',
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'actions-token'
        },
        fetchImpl as typeof fetch
      )
    ).resolves.toEqual({ claimed: false });

    expect(calls).toHaveLength(2);
    expect(calls.some(url => url.endsWith('/executor/manifest'))).toBe(false);
  });

  it('performs OIDC → Claim → manifest → callback for a claimed job', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workflow-runner-happy-'));
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith('https://oidc.example/token')) {
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer actions-token');
        return Response.json({ value: 'oidc-token' });
      }
      if (url.endsWith('/executor/claim')) {
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer oidc-token');
        return Response.json({ lease: 'lease-token' });
      }
      if (url.endsWith('/executor/manifest')) {
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer lease-token');
        return Response.json({
          manifest: {
            version: 1,
            runId: 'run_1',
            stepRunId: 'step_1',
            attemptId: 'att_1',
            operationId: 'op_1',
            capability: 'github.archive_markdown',
            input: {
              content: '# hello',
              source_url: 'https://example.com/'
            }
          }
        });
      }
      if (url.endsWith('/executor/callback')) {
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer lease-token');
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body).toMatchObject({
          kind: 'result',
          callbackId: 'result:att_1:9001:2'
        });
        const result = body.result as Record<string, unknown>;
        expect(result.state).toBe('succeeded');
        return Response.json({ inserted: true, notified: true }, { status: 202 });
      }
      throw new Error(`unexpected request ${url}`);
    });

    await expect(
      runExecutor(
        {
          ATTEMPT_ID: 'att_1',
          CLAIM_NONCE: 'nonce',
          WORKFLOW_MCP_URL: 'https://workflow.example',
          ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example/token',
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'actions-token',
          GITHUB_RUN_ID: '9001',
          GITHUB_RUN_ATTEMPT: '2',
          RUNNER_TEMP: dir
        },
        fetchImpl as typeof fetch
      )
    ).resolves.toEqual({ claimed: true });

    expect(calls).toEqual([
      'https://oidc.example/token?audience=workflow-mcp-worker',
      'https://workflow.example/executor/claim',
      'https://workflow.example/executor/manifest',
      'https://workflow.example/executor/callback'
    ]);
  });
});
