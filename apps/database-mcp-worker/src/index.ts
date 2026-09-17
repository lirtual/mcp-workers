import { createMcpHandler } from '@modelcontextprotocol/server';
import { parseDatabaseConfig } from './config.js';
import { buildMcpServer } from './mcp.js';
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
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/mcp') return new Response('Not found', { status: 404 });

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

    if (typeof env.DATABASE_CONFIG !== 'string' || env.DATABASE_CONFIG.length === 0) {
      return authError(503, 'database_config_not_configured', 'Database configuration is not configured.');
    }

    const catalog = parseDatabaseConfig(env.DATABASE_CONFIG);
    const handler = createMcpHandler(() => buildMcpServer(env, catalog), { legacy: 'stateless' });
    return handler.fetch(portalAuth.request, { authInfo: portalAuth.authInfo });
  }
};
