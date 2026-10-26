import { createMcpHandler } from '@modelcontextprotocol/server';
import { authenticatePortalRequest } from '@mcp-workers/portal-auth';
import { buildMcpServer } from './tools.ts';
import type { Env } from './operations.ts';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/health' && request.method === 'GET')
      return Response.json({ ok: true, service: 'candybox-mcp-worker' }, { headers: { 'cache-control': 'no-store' } });
    if (pathname !== '/mcp') return new Response('Not found', { status: 404 });
    const auth = await authenticatePortalRequest(request, {
      expectedToken: env.MCP_ACCESS_TOKEN, allowedOrigins: [],
    });
    if (!auth.ok) {
      const status = auth.reason === 'misconfigured' ? 503 : auth.reason === 'invalid_origin' ? 403 : 401;
      return Response.json({ error: status === 503 ? 'auth_misconfigured' : 'unauthorized' }, {
        status, headers: { 'cache-control': 'no-store', ...(status === 401 ? { 'www-authenticate': 'Bearer' } : {}) },
      });
    }
    // Neither MCP annotations nor "approve always" establish per-invocation consent.
    // Do not expose side-effectful tools before independently verified host approval.
    return createMcpHandler(() => buildMcpServer(env), { legacy: 'stateless' }).fetch(auth.request);
  },
};
