import { createMcpHandler } from '@modelcontextprotocol/server';
import { buildWorkflowMcpServer } from './mcp.js';
import { authenticateWorkflowPortal } from './portal-auth.js';
import type { Env } from './types.js';

export { WorkflowRuntime } from './workflow.js';

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

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok' });
    }

    if (url.pathname !== '/mcp') return new Response('Not found', { status: 404 });

    const portalAuth = await authenticateWorkflowPortal(request, env);
    if (!portalAuth.ok) {
      if (portalAuth.reason === 'misconfigured') {
        return authError(503, 'portal_auth_not_configured', 'MCP Portal authentication is not configured.');
      }
      if (portalAuth.reason === 'invalid_origin') {
        return authError(403, 'invalid_origin', 'Request Origin is not allowed.');
      }
      return authError(401, 'unauthorized', 'Valid MCP Portal authentication is required.');
    }

    const handler = createMcpHandler(() => buildWorkflowMcpServer(env), { legacy: 'stateless' });
    return handler.fetch(portalAuth.request, { authInfo: portalAuth.authInfo });
  }
} satisfies ExportedHandler<Env>;
