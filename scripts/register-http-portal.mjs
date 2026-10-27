// Register only the selected existing production HTTP Worker on One-MCP.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { attachFixedPortalServer } from './register-mcp-portal-server.mjs';
export { portalPlan } from './register-mcp-portal-server.mjs';

export const HTTP_TOOLS = ['http_request'].sort();
export function attachHTTPPortal(env, transport = fetch) {
  return attachFixedPortalServer(env, {
    id: 'http', name: 'HTTP',
    origin: 'https://http-mcp-worker.aiyaya.workers.dev/mcp',
    description: 'Production public HTTP(S) MCP (#303)',
    tools: HTTP_TOOLS,
  }, transport);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  attachHTTPPortal(process.env).catch(error => {
    const value = String(error?.message ?? '');
    const safe = /^portal_[a-z_]+(?:http_[1-5][0-9]{2})?$/.test(value);
    console.error('HTTP_PORTAL_REGISTRATION_FAILED', safe ? value : 'portal_unavailable');
    process.exitCode = 1;
  });
}
