// Fail-closed pre-attachment Cloudflare Access policy check for MCP servers.
// Registration and tool-sync alone are not evidence that an MCP Access app can
// authenticate callers. This check is read-only: it never creates broad Allow
// rules, edits policies, or discloses selectors/credentials in errors or logs.
const PORTAL = 'MCP';
const PORTAL_HOSTNAME = 'mcp.lirtual.dpdns.org';
// The Portal/Browser Owner policy was deliberately narrowed to two emails.
// Workflow and other MCP workers still use the separately reviewed rule.
const SERVICE_POLICY_ID='7cec582c-4038-4fb0-9ad8-fcdb04af4adc';
const OWNER_POLICIES={
  portal:{id:'07204847-0459-4197-b3c3-2dbe2a47a550',
    name:'MCP Portal and Browser Owners',
    emails:['lirtual@qq.com','lirtual@outlook.com']},
  default:{id:'659d043c-e957-4c91-9f33-2416c52ecbe5',
    name:'Default Allow Rule',
    emails:['lirtual@qq.com','lirtual@outlook.com','lirtual@gmail.com']},
};

function fail(code) { throw new Error('portal_access_policy_' + code); }
function one(items, predicate) {
  const found = items.filter(predicate);
  if (found.length !== 1) fail('app_missing_or_ambiguous');
  return found[0];
}
function signature(app, ownerProfile) {
  const owner=OWNER_POLICIES[ownerProfile];
  const policies = app?.policies;
  if (!Array.isArray(policies) || policies.length !== 2) fail('missing');
  const expected = [
    { name: 'WORKFLOWS', decision: 'non_identity', selector: 'service_token' },
    { name:owner.name,
      decision: 'allow', selector: 'email' },
  ];
  return policies.map((p, i) => {
    const spec = expected[i];
    if (!p || p.name !== spec.name || p.decision !== spec.decision ||
        p.id !== (i === 0 ? SERVICE_POLICY_ID : owner.id) ||
        p.reusable !== true || p.precedence !== i + 1 ||
        typeof p.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(p.id) ||
        !Array.isArray(p.include) || p.include.length < 1 ||
        !p.include.every(s => s && typeof s === 'object' && !Array.isArray(s) &&
          Object.keys(s).length === 1 && Object.hasOwn(s, spec.selector)) ||
        (Array.isArray(p.exclude) && p.exclude.length !== 0) ||
        (Array.isArray(p.require) && p.require.length !== 0))
      fail('baseline_drift');
    if (i === 1) {
      const emails=p.include.map(x=>x.email);
      if (emails.length !== owner.emails.length ||
          !emails.every(x=>x && typeof x === 'object' &&
            !Array.isArray(x) && Object.keys(x).length === 1 &&
            typeof x.email === 'string' && owner.emails.includes(x.email)) ||
          new Set(emails.map(x=>x.email)).size !== emails.length)
        fail('owner_drift');
    }
    return p.id;
  });
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
  const portal = one(data.result, app => app.name === PORTAL &&
    app.type === 'mcp_portal' && app.domain === PORTAL_HOSTNAME);
  const application = one(data.result, app => app.name === target.name &&
    app.type === 'mcp');
  signature(portal,'portal');
  signature(application,target.id === 'browser' ? 'portal' : 'default');
  return true;
}
