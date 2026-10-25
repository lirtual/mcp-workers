import { createMcpHandler } from '@modelcontextprotocol/server';
import { authenticatePortalRequest } from '@mcp-workers/portal-auth';
import { handleSetup } from './setup.ts';
import { buildMcpServer } from './tools.ts';
import { SETUP_HOST } from './types.ts';
import type { Env } from './types.ts';

function denied(status: number, code: string): Response {
  return Response.json({ error: code }, {
    status, headers: { 'cache-control': 'no-store', ...(status === 401 ? { 'www-authenticate': 'Bearer' } : {}) },
  });
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === SETUP_HOST) {
      if (url.pathname.startsWith('/setup') || url.pathname === '/oauth/callback')
        return handleSetup(request, env);
      return new Response('Not found', { status: 404 });
    }
    if (url.pathname !== '/mcp') return new Response('Not found', { status: 404 });
    const auth = await authenticatePortalRequest(request, {
      expectedToken: env.MCP_ACCESS_TOKEN, allowedOrigins: [],
    });
    if (!auth.ok) {
      if (auth.reason === 'misconfigured') return denied(503, 'auth_misconfigured');
      if (auth.reason === 'invalid_origin') return denied(403, 'invalid_origin');
      return denied(401, 'unauthorized');
    }
    if (!env.DB || !env.MAIL_ENCRYPTION_KEY) return denied(503, 'mail_not_configured');
    return createMcpHandler(() => buildMcpServer(env), { legacy: 'stateless' }).fetch(auth.request);
  },
};
