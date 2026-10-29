import { createMcpHandler } from '@modelcontextprotocol/server';
import { buildMcpServer } from './mcp.js';
import { handleSetup } from './setup/handler.js';
import { handleHyperdrivePreflight } from './hyperdrive-preflight.js';
import { authenticateDatabasePortal } from './portal-auth.js';
import type { Env } from './types.js';

function authError(status: number, code: string, message: string): Response {
  return Response.json(
    { error: code, message },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
        ...(status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {})
      }
    }
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/setup' || url.pathname.startsWith('/setup/')) return handleSetup(request, env, fetch, ctx?.access);
    const isPreflight = url.pathname === '/internal/hyperdrive-health';
    if (!isPreflight && url.pathname !== '/mcp') return new Response('Not found', { status: 404 });

    const portalAuth = await authenticateDatabasePortal(request, env);
    if (!portalAuth.ok) {
      if (portalAuth.reason === 'misconfigured') {
        return authError(503, 'portal_auth_not_configured', 'MCP Portal authentication is not configured.');
      }
      if (portalAuth.reason === 'invalid_origin') {
        return authError(403, 'invalid_origin', 'Request Origin is not allowed.');
      }
      return authError(401, 'unauthorized', 'Valid MCP Portal authentication is required.');
    }

    if (!env.DB) {
      return authError(503, 'database_registry_unavailable', 'Database registry is not configured.');
    }

    if (isPreflight) return handleHyperdrivePreflight(portalAuth.request, env);

    const handler = createMcpHandler(() => buildMcpServer(env), { legacy: 'stateless' });
    return handler.fetch(portalAuth.request, { authInfo: portalAuth.authInfo });
  }
};
