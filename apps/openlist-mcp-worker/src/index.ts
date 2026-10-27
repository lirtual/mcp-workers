import { createMcpHandler } from '@modelcontextprotocol/server';
import { authenticatePortalRequest } from '@mcp-workers/portal-auth';
import { createConfig, type Env } from './openlist.ts';
import { buildMcpServer } from './tools.ts';

function deny(status: number, code: string): Response {
  return Response.json({ error: code }, {
    status, headers: { 'cache-control': 'no-store',
      ...(status === 401 ? { 'www-authenticate': 'Bearer' } : {}) },
  });
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET')
      return Response.json({ ok: true, service: 'openlist-mcp-worker' },
        { headers: { 'cache-control': 'no-store' } });
    if (url.pathname !== '/mcp') return deny(404, 'not_found');
    const auth = await authenticatePortalRequest(request, {
      expectedToken: env.MCP_ACCESS_TOKEN, allowedOrigins: [],
    });
    if (!auth.ok) return deny(auth.reason === 'misconfigured' ? 503 :
      auth.reason === 'invalid_origin' ? 403 : 401, 'unauthorized');
    try { createConfig(env); }
    catch { return deny(503, 'upstream_not_configured'); }
    return createMcpHandler(() => buildMcpServer(env), { legacy: 'stateless' }).fetch(auth.request);
  },
};
