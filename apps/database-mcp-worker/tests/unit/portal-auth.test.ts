import { describe, expect, it } from 'vitest';
import { tryPortalOriginAuth } from '../../src/portal-auth.js';
import type { Env } from '../../src/types.js';

const env = {
  MCP_ORIGIN_TOKEN: 'origin-secret',
  OAUTH_REQUIRED_SCOPE: 'db:read'
} as Env;

describe('Portal origin authentication', () => {
  it('returns null when the request should fall back to legacy OAuth', () => {
    expect(tryPortalOriginAuth(new Request('https://db.example/mcp'), env)).toBeNull();
    expect(
      tryPortalOriginAuth(
        new Request('https://db.example/mcp', { headers: { Authorization: 'Bearer oauth-jwt' } }),
        env
      )
    ).toBeNull();
  });

  it('accepts the dedicated origin credential without exposing the secret in authInfo', () => {
    const request = new Request('https://db.example/mcp', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer origin-secret',
        'MCP-Protocol-Version': '2025-11-25'
      }
    });

    const result = tryPortalOriginAuth(request, env);
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.request.headers.has('authorization')).toBe(false);
    expect(result.request.headers.get('mcp-protocol-version')).toBe('2025-11-25');
    expect(result.authInfo).toMatchObject({
      token: 'portal-origin',
      clientId: 'cloudflare-mcp-portal',
      scopes: ['db:read']
    });
    expect(JSON.stringify(result.authInfo)).not.toContain('origin-secret');
  });

  it('is disabled when MCP_ORIGIN_TOKEN is not configured', () => {
    const withoutOriginToken = { OAUTH_REQUIRED_SCOPE: 'db:read' } as Env;
    expect(tryPortalOriginAuth(
      new Request('https://db.example/mcp', { headers: { Authorization: 'Bearer origin-secret' } }),
      withoutOriginToken
    )).toBeNull();
  });
});
