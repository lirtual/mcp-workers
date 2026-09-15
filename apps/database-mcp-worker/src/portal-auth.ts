import { authenticatePortalRequest, type PortalAuthFailureReason } from '@mcp-workers/portal-auth';
import type { AuthInfo } from '@modelcontextprotocol/server';
import type { Env } from './types.js';

export type DatabasePortalAuthResult =
  | { ok: true; request: Request; authInfo: AuthInfo }
  | { ok: false; reason: PortalAuthFailureReason };

export async function authenticateDatabasePortal(
  request: Request,
  env: Env
): Promise<DatabasePortalAuthResult> {
  const result = await authenticatePortalRequest(request, {
    expectedToken: env.MCP_ACCESS_TOKEN,
    allowedOrigins: []
  });
  if (!result.ok) return result;

  return {
    ok: true,
    request: result.request,
    authInfo: {
      // The real Portal credential is consumed at the Worker boundary. Tools
      // receive only a stable logical principal and the database read scope.
      token: 'portal-access',
      clientId: 'cloudflare-mcp-portal',
      scopes: ['db:read']
    }
  };
}
