import { createMcpHandler } from '@modelcontextprotocol/server';
import { authenticatePortalRequest } from '@mcp-workers/portal-auth';
import { buildMcpServer } from './tools.ts';
import type { Env } from './types.ts';

function authError(status: number, code: string, message: string): Response {
  return Response.json({ error: code, message }, {
    status,
    headers: {
      'cache-control': 'no-store',
      ...(status === 401 ? { 'www-authenticate': 'Bearer' } : {}),
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== '/mcp') return new Response('Not found', { status: 404 });
    const auth = await authenticatePortalRequest(request, {
      expectedToken: env.MCP_ACCESS_TOKEN,
      // The Portal's browser Origin is not yet registered for this new app.
      // Server-to-server calls without Origin are accepted; any present Origin fails closed.
      allowedOrigins: [],
    });
    if (!auth.ok) {
      if (auth.reason === 'misconfigured') return authError(503, 'auth_misconfigured', 'MCP Portal authentication is not configured.');
      if (auth.reason === 'invalid_origin') return authError(403, 'invalid_origin', 'Request Origin is not allowed.');
      return authError(401, 'unauthorized', 'Valid MCP Portal authentication is required.');
    }
    const handler = createMcpHandler(() => buildMcpServer(env), { legacy: 'stateless' });
    return handler.fetch(auth.request);
  },
};
