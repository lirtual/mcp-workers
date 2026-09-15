import type { AuthInfo } from '@modelcontextprotocol/server';
import { requiredScope } from './auth.js';
import type { Env } from './types.js';

export interface PortalAuthSuccess {
  request: Request;
  authInfo: AuthInfo;
}

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return diff === 0;
}

/**
 * Returns a Portal auth context only when the bearer exactly matches the
 * dedicated origin credential. Any other bearer is left to the legacy OAuth
 * resource-server verifier during the expand phase.
 */
export function tryPortalOriginAuth(request: Request, env: Env): PortalAuthSuccess | null {
  const expected = env.MCP_ORIGIN_TOKEN;
  if (!expected) return null;

  const authorization = request.headers.get('authorization') ?? '';
  const prefix = 'Bearer ';
  if (!authorization.startsWith(prefix)) return null;

  const presented = authorization.slice(prefix.length);
  if (!presented || !constantTimeEqual(presented, expected)) return null;

  const headers = new Headers(request.headers);
  headers.delete('authorization');

  return {
    request: new Request(request, { headers }),
    authInfo: {
      // Do not expose the origin secret to tools/logging. Portal currently
      // represents one trusted ingress principal at this Worker boundary.
      token: 'portal-origin',
      clientId: 'cloudflare-mcp-portal',
      scopes: [requiredScope(env)]
    }
  };
}
