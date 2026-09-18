import { describe, expect, it } from 'vitest';
import { authenticateWorkflowPortal } from '../src/portal-auth.js';
import type { Env } from '../src/types.js';

const env = { MCP_ACCESS_TOKEN: 'portal-secret' } as Env;

describe('Workflow MCP Portal authentication', () => {
  it('fails closed when MCP_ACCESS_TOKEN is missing', async () => {
    await expect(
      authenticateWorkflowPortal(
        new Request('https://workflow.example/mcp', {
          headers: { Authorization: 'Bearer portal-secret' }
        }),
        {} as Env
      )
    ).resolves.toEqual({ ok: false, reason: 'misconfigured' });
  });

  it('accepts the dedicated Portal credential without exposing it', async () => {
    const result = await authenticateWorkflowPortal(
      new Request('https://workflow.example/mcp', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer portal-secret',
          'MCP-Protocol-Version': '2025-11-25'
        }
      }),
      env
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.headers.has('authorization')).toBe(false);
    expect(result.authInfo).toMatchObject({
      token: 'portal-access',
      clientId: 'cloudflare-mcp-portal',
      scopes: ['workflow:read']
    });
    expect(JSON.stringify(result.authInfo)).not.toContain('portal-secret');
  });

  it('rejects browser Origin because direct browser clients are not supported', async () => {
    await expect(
      authenticateWorkflowPortal(
        new Request('https://workflow.example/mcp', {
          headers: {
            Authorization: 'Bearer portal-secret',
            Origin: 'https://client.example'
          }
        }),
        env
      )
    ).resolves.toEqual({ ok: false, reason: 'invalid_origin' });
  });
});
