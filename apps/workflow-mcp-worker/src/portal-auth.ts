import { authenticatePortalRequest, type PortalAuthFailureReason } from '@mcp-workers/portal-auth';
import type { AuthInfo } from '@modelcontextprotocol/server';
import type { Env } from './types.js';

export type WorkflowPortalAuthResult =
  | { ok: true; request: Request; authInfo: AuthInfo }
  | { ok: false; reason: PortalAuthFailureReason };

export async function authenticateWorkflowPortal(
  request: Request,
  env: Env
): Promise<WorkflowPortalAuthResult> {
  const result = await authenticatePortalRequest(request, {
    ...(env.MCP_ACCESS_TOKEN ? { expectedToken: env.MCP_ACCESS_TOKEN } : {}),
    allowedOrigins: []
  });
  if (!result.ok) return result;

  return {
    ok: true,
    request: result.request,
    authInfo: {
      token: 'portal-access',
      clientId: 'cloudflare-mcp-portal',
      scopes: ['workflow:read']
    }
  };
}
