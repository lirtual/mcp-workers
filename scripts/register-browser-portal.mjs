// Register only the existing production Browser Worker on One-MCP. Never log credentials.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { attachFixedPortalServer } from './register-mcp-portal-server.mjs';
export const BROWSER_TOOLS = [
  'browser_click','browser_fill','browser_keypress','browser_scroll','browser_select',
  'browser_pair','browser_endpoints','browser_tabs','browser_snapshot',
  'browser_screenshot','browser_tab_open','browser_tab_navigate',
  'browser_tab_close','browser_stop','browser_revoke','browser_operation_status',
].sort();
export function attachBrowserPortal(env, transport = fetch) {
  return attachFixedPortalServer(env, {
    id: 'browser', name: 'Browser', origin: 'https://browser.lirtual.dpdns.org/mcp',
    description: 'Production owner-paired Chrome/Edge Browser MCP (Spec #418)', tools: BROWSER_TOOLS,
  }, transport);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  attachBrowserPortal(process.env).catch(error => {
    const message = String(error?.message ?? '');
    const safe = /^portal_[a-z_]+(?:browser_[1-5][0-9]{2})?$/.test(message);
    console.error('BROWSER_PORTAL_REGISTRATION_FAILED', safe ? message : 'portal_unavailable');
    process.exitCode = 1;
  });
}
