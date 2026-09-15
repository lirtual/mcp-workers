import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  requireBearerAuth,
  type AuthInfo
} from '@modelcontextprotocol/server';
import { protectedResourceMetadata, requiredScope, verifyAccessToken } from './auth.js';
import { parseConnectionCatalog } from './config.js';
import { buildMcpServer } from './mcp.js';
import { tryPortalOriginAuth } from './portal-auth.js';
import type { Env } from './types.js';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const metadata = protectedResourceMetadata(request, env);
    if (metadata) return metadata;

    const url = new URL(request.url);
    if (url.pathname !== '/mcp') return new Response('Not found', { status: 404 });

    const catalog = parseConnectionCatalog(env.CONNECTIONS_JSON);
    const portalAuth = tryPortalOriginAuth(request, env);

    let mcpRequest = request;
    let auth: AuthInfo;

    if (portalAuth) {
      mcpRequest = portalAuth.request;
      auth = portalAuth.authInfo;
    } else {
      // Expand phase: preserve the existing client-facing OAuth resource-server path.
      const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(new URL('/mcp', url.origin));
      const gate = requireBearerAuth({
        verifier: { verifyAccessToken: token => verifyAccessToken(token, env) },
        requiredScopes: [requiredScope(env)],
        resourceMetadataUrl
      });
      const legacyAuth = await gate(request);
      if (legacyAuth instanceof Response) return legacyAuth;
      auth = legacyAuth;
    }

    const handler = createMcpHandler(() => buildMcpServer(env, catalog), { legacy: 'stateless' });
    return handler.fetch(mcpRequest, { authInfo: auth });
  }
};
