import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo
} from '@modelcontextprotocol/server';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Env } from './types.js';

const jwksByUrl = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(url: string): ReturnType<typeof createRemoteJWKSet> {
  const existing = jwksByUrl.get(url);
  if (existing) return existing;
  const created = createRemoteJWKSet(new URL(url));
  jwksByUrl.set(url, created);
  return created;
}

function scopesFromPayload(payload: JWTPayload): string[] {
  const scope = payload.scope;
  if (typeof scope === 'string') return scope.split(/\s+/).filter(Boolean);

  const scp = payload.scp;
  if (typeof scp === 'string') return scp.split(/\s+/).filter(Boolean);
  if (Array.isArray(scp)) return scp.filter((item): item is string => typeof item === 'string');
  return [];
}

export function requiredScope(env: Env): string {
  const scope = env.OAUTH_REQUIRED_SCOPE?.trim() || 'db:read';
  if (scope === 'offline_access' || scope.length > 128 || /\s/.test(scope)) {
    throw new Error('OAUTH_REQUIRED_SCOPE must be a single non-offline_access scope.');
  }
  return scope;
}

export async function verifyAccessToken(token: string, env: Env): Promise<AuthInfo> {
  try {
    new URL(env.OAUTH_ISSUER);
    const issuer = env.OAUTH_ISSUER;
    const jwksUrl = new URL(env.OAUTH_JWKS_URL).href;
    const audience = env.OAUTH_AUDIENCE;
    if (!audience) throw new Error('Missing audience');

    const { payload } = await jwtVerify(token, getJwks(jwksUrl), {
      issuer,
      audience
    });

    if (typeof payload.sub !== 'string' || payload.sub.length === 0) throw new Error('Missing subject');
    if (typeof payload.exp !== 'number') throw new Error('Missing expiry');

    return {
      token,
      clientId: payload.sub,
      scopes: scopesFromPayload(payload),
      expiresAt: payload.exp
    };
  } catch {
    throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid access token');
  }
}

export function protectedResourceMetadata(request: Request, env: Env): Response | undefined {
  const url = new URL(request.url);
  const expectedPath = '/.well-known/oauth-protected-resource/mcp';
  if (url.pathname !== expectedPath) return undefined;
  if (request.method !== 'GET') {
    return new Response(null, { status: 405, headers: { Allow: 'GET', 'Access-Control-Allow-Origin': '*' } });
  }

  const mcpUrl = new URL('/mcp', url.origin).href;
  const body = {
    resource: mcpUrl,
    authorization_servers: [env.OAUTH_ISSUER],
    scopes_supported: [requiredScope(env)],
    bearer_methods_supported: ['header']
  };
  return Response.json(body, {
    headers: {
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
