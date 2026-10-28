// Runs only after a separately authorized OpenList Worker production release.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { attachFixedPortalServer } from './register-mcp-portal-server.mjs';

export const OPENLIST_TOOLS = [
  'openlist_capabilities', 'openlist_list_files', 'openlist_get_file',
  'openlist_search_files', 'openlist_read_text', 'openlist_share_get',
  'openlist_download_link', 'openlist_share_disable',
  'openlist_upload_small', 'openlist_rename', 'openlist_copy', 'openlist_move',
  'openlist_create_folder',
  'openlist_delete', 'openlist_share_create', 'openlist_share_update',
  'openlist_share_enable', 'openlist_share_revoke',
].sort();

export function attachOpenListPortal(env, transport = fetch) {
  return attachFixedPortalServer(env, {
    id: 'openlist', name: 'OpenList MCP',
    origin: 'https://openlist-mcp-worker.aiyaya.workers.dev/mcp',
    description: 'Scoped OpenList MCP via internal Service Binding (Spec #309)',
    tools: OPENLIST_TOOLS,
  }, transport);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  attachOpenListPortal(process.env).catch(error => {
    const value = String(error?.message ?? '');
    const safe = /^portal_[a-z0-9_-]+$/.test(value);
    console.error('OPENLIST_PORTAL_REGISTRATION_FAILED', safe ? value : 'portal_unavailable');
    process.exitCode = 1;
  });
}
