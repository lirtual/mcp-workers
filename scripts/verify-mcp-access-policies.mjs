// Fail-closed pre-attachment Cloudflare Access policy check for MCP servers.
// Registration and tool-sync alone are not evidence that an MCP Access app can
// authenticate callers. This check is read-only: it never creates broad Allow
// rules, edits policies, or discloses selectors/credentials in errors or logs.
// Current reviewed Portal identity and reusable policies (Spec #878).
export const PORTAL_ID = 'mcp-portal';
export const PORTAL_NAME = 'MCP Portal';
export const PORTAL_HOSTNAME = 'mcp-portal.lirtual.dpdns.org';
const SERVICE_POLICY = {
  id:'b3dcac1d-c37e-40f0-b201-1d5f08f81577',
  name:'MCP Gateway Service Auth',decision:'non_identity',
  selector:'service_token',field:'token_id',
  values:['93f24170-6bf8-4a06-bf97-fb11bd9268bf','8624dd66-918c-41bf-9637-676da2503524'],
};
const OWNER_POLICY = {
  id:'659d043c-e957-4c91-9f33-2416c52ecbe5',
  name:'Default Allow Rule',decision:'allow',selector:'email',field:'email',
  values:['lirtual@qq.com','lirtual@outlook.com','lirtual@gmail.com'],
};

function fail(code) { throw new Error('portal_access_policy_' + code); }
function one(items, predicate) {
  const found = items.filter(predicate);
  if (found.length !== 1) fail('app_missing_or_ambiguous');
  return found[0];
}
function signature(app, serviceFirst) {
  const policies = app?.policies;
  if (!Array.isArray(policies) || policies.length !== 2) fail('missing');
  // Portal and Browser use service-first precedence; the other reviewed
  // MCP applications use owner-first precedence. Both keep the same exact
  // reusable policy identities and selectors.
  const expected = serviceFirst ? [SERVICE_POLICY, OWNER_POLICY] : [OWNER_POLICY, SERVICE_POLICY];
  for (const [i, spec] of expected.entries()) {
    const p=policies[i];
    if (!p || p.name !== spec.name || p.decision !== spec.decision ||
        p.id !== spec.id || p.reusable !== true || p.precedence !== i+1 ||
        !Array.isArray(p.include) || p.include.length !== spec.values.length ||
        !Array.isArray(p.exclude) || p.exclude.length !== 0 ||
        !Array.isArray(p.require) || p.require.length !== 0)
      fail('baseline_drift');
    const seen=new Set();
    for(const selector of p.include) {
      const value=selector?.[spec.selector];
      if (!selector || typeof selector !== 'object' || Array.isArray(selector) ||
          Object.keys(selector).length !== 1 ||
          !value || typeof value !== 'object' || Array.isArray(value) ||
          Object.keys(value).length !== 1 || !spec.values.includes(value[spec.field]) ||
          seen.has(value[spec.field])) fail('selector_drift');
      seen.add(value[spec.field]);
    }
  }
}

export async function verifyMcpAccessPolicies(env, target, transport = fetch) {
  if (!target || !/^[a-z][a-z0-9-]{0,31}$/.test(target.id ?? '') ||
      typeof target.name !== 'string' || !target.name.trim() ||
      (target.id === 'browser') !== (target.name === 'Browser'))
    fail('target_invalid');
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN;
  if (typeof account !== 'string' || !/^[0-9a-f]{32}$/.test(account) ||
      typeof token !== 'string' || !token.trim()) fail('auth_unavailable');
  let response;
  try {
    response = await transport(new Request(
      'https://api.cloudflare.com/client/v4/accounts/' + account +
        '/access/apps?per_page=100', {
        method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(12000),
        headers: {authorization: 'Bearer ' + token, accept: 'application/json'},
      },
    ));
  } catch { fail('read_unavailable'); }
  if (response.status !== 200 || response.redirected ||
      response.headers.has('location')) fail('read_unavailable');
  let data;
  try { data = await response.json(); } catch { fail('read_unavailable'); }
  if (data?.success !== true || !Array.isArray(data.result) ||
      data.result_info?.total_pages !== 1 || data.result.length < 2 ||
      data.result.length > 100) fail('inventory_unverifiable');
  const portal = one(data.result, app => app.name === PORTAL_NAME &&
    app.type === 'mcp_portal' && app.domain === PORTAL_HOSTNAME);
  const application = one(data.result, app => app.name === target.name &&
    app.type === 'mcp');
  signature(portal,true);
  signature(application,target.id === 'browser');
  return true;
}
