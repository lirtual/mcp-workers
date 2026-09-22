import { createMcpHandler } from '@modelcontextprotocol/server';
import { handleAdminRoute } from './admin-routes.js';
import { handleExecutorRoute } from './executor-routes.js';
import { buildWorkflowMcpServer } from './mcp.js';
import { authenticateWorkflowPortal } from './portal-auth.js';
import { runSchedulerTick } from './scheduler.js';
import { handleWebhookTrigger } from './triggers.js';
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

    if (url.pathname.startsWith('/admin/')) {
      const adminResponse = await handleAdminRoute(request, env);
      if (adminResponse) return adminResponse;
    }

    if (url.pathname.startsWith('/executor/')) {
      const executorResponse = await handleExecutorRoute(request, env);
      if (executorResponse) return executorResponse;
    }

    const webhookMatch = url.pathname.match(/^\/hooks\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/);
    if (webhookMatch) {
      return handleWebhookTrigger(request, env, webhookMatch[1]!, webhookMatch[2]!);
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
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const result = await runSchedulerTick(env, controller.scheduledTime);
    if (result.errors > 0) {
      throw new Error(`Scheduler tick completed with ${result.errors} schedule error(s).`);
    }
  }
} satisfies ExportedHandler<Env>;
