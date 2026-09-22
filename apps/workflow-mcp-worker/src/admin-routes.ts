import { getConnection } from './connections.js';
import { verifyGitHubOidcToken, type GitHubOidcVerificationConfig } from './oidc.js';
import { GITHUB_EXECUTOR_CONFIG } from './platform-config.js';
import { getWorkflowRegistry } from './registry.js';
import type { Env } from './types.js';

const ADMIN_AUDIENCE = 'workflow-mcp-publisher';
const INITIAL_POLICY_REVISION = 1;

type AdminEnv = Env & {
  ADMIN_PUBLISHER_REPOSITORY_ID?: string;
  ADMIN_PUBLISHER_WORKFLOW_REF?: string;
  ADMIN_PUBLISHER_REF?: string;
  ADMIN_PUBLISHER_WORKFLOW_SHA?: string;
};

export interface AdminRouteOptions {
  fetchImpl?: typeof fetch;
  nowSeconds?: number;
}

function reply(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
}

function required(value: string | undefined): string | undefined {
  return value && value.trim() === value && value.length > 0 ? value : undefined;
}

function policySnapshot(): Record<string, unknown> {
  const connections: Record<string, unknown> = {};
  // This is the bounded approved bootstrap configuration; never expose connection.auth or Env.
  for (const id of ['workflow-self', 'raindrop']) {
    const connection = getConnection(id);
    if (!connection) throw new Error('Approved connection configuration is unavailable.');
    connections[id] = {
      tools: Object.fromEntries(Object.entries(connection.tools).map(([name, tool]) => [
        name, {
          effect: tool.effect,
          ...(tool.operationIdArgument ? { operationIdArgument: tool.operationIdArgument } : {})
        }
      ]))
    };
  }
  const webhookBindings: Array<{ workflowId: string; triggerId: string; referenceId: string }> = [];
  for (const entry of getWorkflowRegistry()) {
    const plan = entry.plan as { triggers?: Array<Record<string, unknown>> };
    for (const trigger of plan.triggers ?? []) {
      if (trigger.type === 'webhook' && typeof trigger.id === 'string' && typeof trigger.secret === 'string') {
        webhookBindings.push({
          workflowId: entry.metadata.id,
          triggerId: trigger.id,
          referenceId: trigger.secret
        });
      }
    }
  }
  return { revision: INITIAL_POLICY_REVISION, connections, webhookBindings };
}

export async function handleAdminRoute(
  request: Request,
  env: AdminEnv,
  options: AdminRouteOptions = {}
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/admin/')) return null;
  if (url.pathname !== '/admin/connections/snapshot') return reply(404, 'not_found');
  if (request.method !== 'GET') return reply(405, 'method_not_allowed');

  const repositoryId = required(env.ADMIN_PUBLISHER_REPOSITORY_ID);
  const workflowRef = required(env.ADMIN_PUBLISHER_WORKFLOW_REF);
  const ref = required(env.ADMIN_PUBLISHER_REF);
  if (!repositoryId || !workflowRef || !ref) {
    return reply(503, 'admin_auth_not_configured');
  }

  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ') || authorization.length <= 7) {
    return reply(401, 'unauthorized');
  }
  try {
    const oidc: GitHubOidcVerificationConfig = { ...GITHUB_EXECUTOR_CONFIG.oidc, audience: ADMIN_AUDIENCE };
    const identity = await verifyGitHubOidcToken(
      authorization.slice(7), oidc, options.fetchImpl ?? fetch, options.nowSeconds
    );
    if (identity.repositoryId !== repositoryId || identity.workflowRef !== workflowRef ||
        identity.ref !== ref || (env.ADMIN_PUBLISHER_WORKFLOW_SHA &&
        identity.workflowSha !== env.ADMIN_PUBLISHER_WORKFLOW_SHA)) {
      return reply(403, 'publisher_identity_mismatch');
    }
    return Response.json(policySnapshot(), { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    // Never reflect raw credentials, JWT parsing details or platform Secret names.
    return reply(401, 'unauthorized');
  }
}
