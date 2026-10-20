import { createMcpHandler } from '@modelcontextprotocol/server';
import { authenticatePortalRequest } from '@mcp-workers/portal-auth';
import { buildMcpServer } from './tools.ts';

import type { Env } from './github.ts';

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, {
    status, headers: {
      'cache-control': 'no-store',
      ...(status === 401 ? { 'www-authenticate': 'Bearer' } : {}),
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') {
      return Response.json({ ok: true, service: 'github-actions-mcp-worker' }, {
        headers: { 'cache-control': 'no-store' },
      });
    }
    if (url.pathname !== '/mcp') return new Response('Not found', { status: 404 });

    const auth = await authenticatePortalRequest(request, {
      expectedToken: env.MCP_ACCESS_TOKEN,
      allowedOrigins: [],
    });
    if (!auth.ok) {
      if (auth.reason === 'misconfigured') return jsonError(503, 'auth_misconfigured');
      if (auth.reason === 'invalid_origin') return jsonError(403, 'invalid_origin');
      return jsonError(401, 'unauthorized');
    }
    if (!env.GH_TOKEN?.trim() ||
        (env.GH_TOKEN_SECONDARY?.trim() && env.GH_TOKEN_SECONDARY.trim() === env.GH_TOKEN.trim())) {
      return jsonError(503, 'github_not_configured');
    }
    const handler = createMcpHandler(() => buildMcpServer(env), { legacy: 'stateless' });
    return handler.fetch(auth.request);
  },
};
