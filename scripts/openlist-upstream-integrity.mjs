// Read-only integrity check for the existing OpenList upstream Worker.
// This does not repair bindings, read KV keys, modify Forks, or deploy anything.
const WORKER = 'openlist-tsworkers';
const KV_ID = '298dbc9310f948c796522911d0405379';
const PUBLIC_SETTINGS = 'https://openlist.lirtual.dpdns.org/api/public/settings';
const MAX_BYTES = 128 * 1024;

function fail(reason) {
  throw new Error('openlist_upstream_' + reason);
}

async function getJson(url, token, transport) {
  let response;
  try {
    response = await transport(new Request(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(12000),
      headers: token
        ? { authorization: 'Bearer ' + token, accept: 'application/json' }
        : { accept: 'application/json' },
    }));
  } catch { fail('unreachable'); }
  if (response.status !== 200 || response.redirected ||
      response.headers.has('location')) fail('http_status');
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
    fail('content_type');
  const reader = response.body?.getReader();
  if (!reader) fail('empty_body');
  const pieces = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) fail('response_too_large');
      pieces.push(value);
    }
  } catch { fail('read_error'); }
  finally { void reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const piece of pieces) {
    bytes.set(piece, offset);
    offset += piece.byteLength;
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('invalid_json'); }
}

export async function verifyOpenListUpstream(env, transport = fetch) {
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN;
  if (typeof account !== 'string' || !/^[a-f0-9]{32}$/i.test(account) ||
      typeof token !== 'string' || !token || token.trim() !== token ||
      /[\r\n]/.test(token)) fail('missing_credentials');

  const base = 'https://api.cloudflare.com/client/v4/accounts/' + account +
    '/workers/scripts/' + WORKER;
  const [deployment, publicSettings] = await Promise.all([
    getJson(base + '/deployments?per_page=1', token, transport),
    getJson(PUBLIC_SETTINGS, null, transport),
  ]);
  if (deployment?.success !== true ||
      !Array.isArray(deployment.result?.deployments) ||
      deployment.result.deployments.length !== 1)
    fail('deployment_unavailable');
  const versions = deployment.result.deployments[0]?.versions;
  if (!Array.isArray(versions) || versions.length !== 1 ||
      versions[0]?.percentage !== 100 ||
      !/^[a-f0-9-]{36}$/i.test(versions[0]?.version_id || ''))
    fail('active_version_ambiguous');

  const versionId = versions[0].version_id;
  const version = await getJson(base + '/versions/' + versionId, token, transport);
  if (version?.success !== true || version.result?.id !== versionId)
    fail('version_unavailable');
  const bindings = version.result?.resources?.bindings;
  if (!Array.isArray(bindings) ||
      bindings.filter(x => x?.name === 'KV').length !== 1 ||
      !bindings.some(x => x.name === 'KV' && x.type === 'kv_namespace' &&
        x.namespace_id === KV_ID))
    fail('kv_binding_drift');
  if (bindings.filter(x => x?.name === 'DB_DRIVER').length !== 1 ||
      !bindings.some(x => x.name === 'DB_DRIVER' && x.type === 'plain_text' &&
        x.text === 'auto'))
    fail('db_driver_drift');
  if (publicSettings?.code !== 200 || publicSettings?.message !== 'success' ||
      !publicSettings?.data || typeof publicSettings.data !== 'object')
    fail('storage_unavailable');
  return versionId;
}

if (process.argv[1]?.endsWith('/openlist-upstream-integrity.mjs')) {
  verifyOpenListUpstream(process.env)
    .then(version => console.log('OPENLIST_UPSTREAM_READ_OK version=' + version))
    .catch(error => {
      const code = /^openlist_upstream_[a-z_]+$/.test(error?.message)
        ? error.message : 'openlist_upstream_unknown';
      console.error('OPENLIST_UPSTREAM_READ_FAILED ' + code);
      process.exitCode = 1;
    });
}
