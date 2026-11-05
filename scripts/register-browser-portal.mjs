// Register only the existing production Browser Worker on One-MCP. Never log credentials.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { attachFixedPortalServer } from './register-mcp-portal-server.mjs';
// Compare the Portal's stored tool metadata with the reviewed Browser Worker
// contract. This is post-sync readback only: it does not retry synchronization.
export const BROWSER_UUIDV7_PATTERN = '^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}  'browser_click','browser_fill','browser_keypress','browser_scroll','browser_select',
  'browser_endpoints','browser_tabs','browser_snapshot',
  'browser_screenshot','browser_tab_open','browser_tab_navigate',
  'browser_tab_close','browser_stop','browser_revoke','browser_operation_status',
].sort();
export function attachBrowserPortal(env, transport = fetch) {
  return attachFixedPortalServer(env, {
    id: 'browser', name: 'Browser', origin: 'https://browser.lirtual.dpdns.org/mcp',
    description: 'Owner-activated Chrome/Edge Browser MCP (Spec #418 + #531)', tools: BROWSER_TOOLS,
    verifyTools: verifyBrowserToolSchemas,
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
;
const INTENT_TOOLS = [
  'browser_click','browser_fill','browser_keypress','browser_scroll','browser_select',
  'browser_tab_open','browser_tab_navigate','browser_tab_close','browser_operation_status',
];
export function verifyBrowserToolSchemas(tools) {
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  for (const name of INTENT_TOOLS) {
    if (byName.get(name)?.inputSchema?.properties?.intent_key?.pattern !== BROWSER_UUIDV7_PATTERN) {
      throw Error('portal_browser_intent_key_schema_drift');
    }
  }
  const receipt = byName.get('browser_operation_status')?.inputSchema;
  if (!receipt || Object.hasOwn(receipt, 'oneOf') ||
    receipt.additionalProperties !== false ||
    JSON.stringify(receipt.required) !== '["endpoint_id"]' ||
    Object.keys(receipt.properties ?? {}).sort().join(',') !== 'endpoint_id,intent_key,operation_id') {
    throw Error('portal_browser_receipt_schema_drift');
  }
}
export const BROWSER_TOOLS = [
  'browser_click','browser_fill','browser_keypress','browser_scroll','browser_select',
  'browser_endpoints','browser_tabs','browser_snapshot',
  'browser_screenshot','browser_tab_open','browser_tab_navigate',
  'browser_tab_close','browser_stop','browser_revoke','browser_operation_status',
].sort();
export function attachBrowserPortal(env, transport = fetch) {
  return attachFixedPortalServer(env, {
    id: 'browser', name: 'Browser', origin: 'https://browser.lirtual.dpdns.org/mcp',
    description: 'Owner-activated Chrome/Edge Browser MCP (Spec #418 + #531)', tools: BROWSER_TOOLS,
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
