import { describe, expect, it } from 'vitest';
import { authenticateDatabasePortal } from '../../src/portal-auth.js';
import type { Env } from '../../src/types.js';

const env = {
  MCP_ACCESS_TOKEN: 'portal-secret'
} as Env;

describe('Database Portal authentication', () => {
  it('fails closed when MCP_ACCESS_TOKEN is not configured', async () => {
    const result = await authenticateDatabasePortal(
      new Request('https://db.example/mcp', { headers: { Authorization: 'Bearer portal-secret' } }),
      {} as Env
    );
    expect(result).toEqual({ ok: false, reason: 'misconfigured' });
  });

  it('rejects missing or incorrect bearer instead of falling back to legacy OAuth', async () => {
    await expect(authenticateDatabasePortal(new Request('https://db.example/mcp'), env)).resolves.toEqual({
      ok: false,
      reason: 'unauthorized'
    });
    await expect(
      authenticateDatabasePortal(
        new Request('https://db.example/mcp', { headers: { Authorization: 'Bearer old-oauth-jwt' } }),
        env
      )
    ).resolves.toEqual({ ok: false, reason: 'unauthorized' });
  });

  it('accepts the dedicated Portal credential without exposing it in AuthInfo', async () => {
    const request = new Request('https://db.example/mcp', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer portal-secret',
        'MCP-Protocol-Version': '2025-11-25'
      }
    });

    const result = await authenticateDatabasePortal(request, env);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.request.headers.has('authorization')).toBe(false);
    expect(result.request.headers.get('mcp-protocol-version')).toBe('2025-11-25');
    expect(result.authInfo).toMatchObject({
      token: 'portal-access',
      clientId: 'cloudflare-mcp-portal',
      scopes: ['db:read']
    });
    expect(JSON.stringify(result.authInfo)).not.toContain('portal-secret');
  });

  it('rejects browser Origin because no direct browser client is supported', async () => {
    const result = await authenticateDatabasePortal(
      new Request('https://db.example/mcp', {
        headers: {
          Authorization: 'Bearer portal-secret',
          Origin: 'https://client.example'
        }
      }),
      env
    );
    expect(result).toEqual({ ok: false, reason: 'invalid_origin' });
  });
});
