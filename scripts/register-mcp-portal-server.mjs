// Shared guarded One-MCP registration for already deployed, explicitly selected Workers.
// Never log Cloudflare bearer, upstream secret, or sensitive tools payloads.
import assert from 'node:assert/strict';
import { portalServerMapping, assertSamePortalMappings } from './register-workflow-portal.mjs';

export function portalPlan(portal) {
  assert.equal(portal?.id, 'one-mcp', 'portal_identity_drift');
  assert.equal(portal?.name, 'One-MCP', 'portal_identity_drift');
  assert.equal(portal?.hostname, 'mcp.lirtual.dpdns.org', 'portal_identity_drift');
  assert.ok(Array.isArray(portal.servers) && portal.servers.length >= 9,
    'portal_existing_servers_missing');
  const servers = portal.servers.map(portalServerMapping);
  const ids = servers.map(x => x.server_id);
  assert.equal(new Set(ids).size, ids.length, 'portal_duplicate_server');
  for (const id of ['workflow', 'database', 'ima', 'raindrop'])
    assert.ok(ids.includes(id), 'portal_existing_servers_missing');
  return { name: portal.name, hostname: portal.hostname,
    ...(typeof portal.description === 'string' ? { description: portal.description } : {}),
    code_mode: portal.code_mode, secure_web_gateway: portal.secure_web_gateway, servers };
}

export async function attachFixedPortalServer(env, target, transport = fetch) {
  const { id, name, origin, tools, description } = target;
  assert.match(id, /^[a-z][a-z0-9-]{0,31}$/, 'portal_server_invalid');
  assert.ok(typeof name === 'string' && name.length < 65, 'portal_server_invalid');
  assert.ok(typeof origin === 'string' && origin.startsWith('https://') &&
    new URL(origin).pathname === '/mcp', 'portal_server_invalid');
  assert.ok(Array.isArray(tools) && tools.length > 0 && new Set(tools).size === tools.length,
    'portal_tools_invalid');
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const cfToken = env.CLOUDFLARE_API_TOKEN;
  const workerToken = env.MCP_ACCESS_TOKEN;
  assert.match(account ?? '', /^[a-f0-9]{32}$/, 'portal_account_invalid');
  assert.ok(typeof cfToken === 'string' && cfToken.length > 0, 'portal_admin_token_missing');
  assert.ok(typeof workerToken === 'string' && workerToken.length > 0 &&
    !/\r|\n/.test(workerToken), 'portal_worker_token_missing');
  const api = 'https://api.cloudflare.com/client/v4/accounts/' + account + '/access/ai-controls/mcp';
  const request = async (method, tail, body) => {
    const res = await transport(new Request(api + tail, {
      method, redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: { authorization: 'Bearer ' + cfToken, accept: 'application/json',
        'content-type': 'application/json', 'user-agent': 'mcp-workers-portal-registration' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    if (!res.ok) throw Error('portal_' + method.toLowerCase() + '_http_' + res.status);
    let json;
    try { json = await res.json(); } catch { throw Error('portal_invalid_json'); }
    if (json?.success !== true || json.result == null) throw Error('portal_api_unavailable');
    return json.result;
  };
  const before = portalPlan(await request('GET', '/portals/one-mcp'));
  assert.ok(before.servers.filter(x => x.server_id === id).length <= 1,
    'portal_duplicate_' + id);
  const existing = await request('GET', '/servers');
  assert.ok(Array.isArray(existing) && existing.length >= 9, 'portal_inventory_incomplete');
  let server = existing.find(x => x.id === id);
  if (server) {
    assert.equal(server.hostname, origin, 'portal_' + id + '_endpoint_drift');
    assert.equal(server.auth_type, 'bearer', 'portal_' + id + '_auth_drift');
  } else {
    server = await request('POST', '/servers', {
      id, name, hostname: origin, auth_type: 'bearer',
      auth_credentials: workerToken, description,
    });
    assert.equal(server.id, id, 'portal_' + id + '_create_mismatch');
    console.log(id.toUpperCase() + '_PORTAL_SERVER_CREATED');
  }
  const synced = await request('POST', '/servers/' + id + '/sync');
  assert.equal(synced.status, 'ready', 'portal_' + id + '_sync_failed');
  let detail = await request('GET', '/servers/' + id);
  for (let i = 0; i < 10 && detail.status !== 'ready'; i++) {
    await new Promise(done => setTimeout(done, 1000));
    detail = await request('GET', '/servers/' + id);
  }
  assert.equal(detail.status, 'ready', 'portal_' + id + '_not_ready');
  assert.equal(detail.hostname, origin, 'portal_' + id + '_endpoint_drift');
  assert.equal(detail.auth_type, 'bearer', 'portal_' + id + '_auth_drift');
  assert.deepEqual((detail.tools ?? []).map(x => x.name).sort(), [...tools].sort(),
    'portal_' + id + '_tool_inventory_drift');
  console.log(id.toUpperCase() + '_PORTAL_TOOLS_SYNCED');
  const fresh = portalPlan(await request('GET', '/portals/one-mcp'));
  assertSamePortalMappings(before.servers, fresh.servers);
  if (!fresh.servers.some(x => x.server_id === id)) {
    const updated = await request('PUT', '/portals/one-mcp', {
      ...fresh, servers: [...fresh.servers, { server_id: id, on_behalf: false, default_disabled: false }],
    });
    assert.ok(updated.servers?.some(x => x.server_id === id), 'portal_' + id + '_attach_failed');
  }
  const after = portalPlan(await request('GET', '/portals/one-mcp'));
  const priorIds = new Set(before.servers.map(x => x.server_id));
  assertSamePortalMappings(before.servers, after.servers.filter(x => priorIds.has(x.server_id)));
  assert.equal(after.servers.filter(x => x.server_id === id).length, 1, 'portal_' + id + '_attach_failed');
  assert.equal(after.servers.length, before.servers.length +
    (before.servers.some(x => x.server_id === id) ? 0 : 1), 'portal_count_drift');
  assert.equal(after.code_mode, before.code_mode, 'portal_code_mode_changed');
  assert.equal(after.secure_web_gateway, before.secure_web_gateway, 'portal_gateway_mode_changed');
  console.log(id.toUpperCase() + '_PORTAL_REGISTRATION_SUCCESS');
  return true;
}
