// Explicit, manual disposable-driver E2E; does not deploy or register a Portal.
// Any error returns only a stable code: never log tokens, file contents, or upstream bodies.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const ROOT = '/Koofr/Downloads';
const MCP = 'https://openlist-mcp-worker.aiyaya.workers.dev/mcp';
const UPSTREAM = 'https://openlist.lirtual.dpdns.org/api/fs/put';

function stop(code) { throw Error('openlist_driver_e2e_' + code); }
function check(condition, code) { if (!condition) stop(code); }

async function boundedJson(response, cap = 32768) {
  const rawSize = response.headers.get('content-length');
  if (rawSize !== null) check(/^\d+$/.test(rawSize) && Number(rawSize) <= cap, 'response_limit');
  if (!response.body) stop('missing_response');
  const reader = response.body.getReader();
  let length = 0; const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      check(length <= cap, 'response_limit');
      chunks.push(value);
    }
  } catch { stop('response_read'); }
  finally { void reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let text;
  try { text = new TextDecoder('utf-8', { fatal:true }).decode(bytes); }
  catch { stop('invalid_utf8'); }
  let json;
  try {
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim();
    if (contentType === 'application/json') json = JSON.parse(text);
    else if (contentType === 'text/event-stream') {
      const events = [...text.matchAll(/^data:\s*(\{.*\})\s*$/gm)];
      check(events.length === 1, 'invalid_sse');
      json = JSON.parse(events[0][1]);
    } else stop('invalid_content_type');
  } catch { stop('invalid_json'); }
  return json;
}

export async function runOpenListDriverAcceptance(env, transport = fetch) {
  check(env.OPENLIST_DRIVER_E2E_APPROVED === 'true', 'not_approved');
  // Match the existing release's authenticated MCP smoke and secret-staging
  // contract: nonempty, no leading/trailing whitespace, no CR/LF. Arbitrary
  // minimum-length rules must not be added only to an acceptance fixture.
  check(typeof env.MCP_ACCESS_TOKEN === 'string' &&
    env.MCP_ACCESS_TOKEN.length > 0 &&
    env.MCP_ACCESS_TOKEN.trim() === env.MCP_ACCESS_TOKEN &&
    !/[\r\n]/.test(env.MCP_ACCESS_TOKEN), 'missing_mcp_token');
  check(typeof env.OPENLIST_API_TOKEN === 'string' &&
    env.OPENLIST_API_TOKEN.length > 0 &&
    env.OPENLIST_API_TOKEN.trim() === env.OPENLIST_API_TOKEN &&
    !/[\r\n]/.test(env.OPENLIST_API_TOKEN) &&
    env.OPENLIST_API_TOKEN !== env.MCP_ACCESS_TOKEN, 'missing_upstream_token');
  let roots;
  try { roots = JSON.parse(env.OPENLIST_ALLOWED_ROOTS); }
  catch { stop('invalid_roots'); }
  // Initial acceptance uses one deliberately reviewed, non-root Koofr location.
  check(Array.isArray(roots) && roots.length === 1 && roots[0] === ROOT, 'unexpected_root');
  const id = env.GITHUB_RUN_ID, attempt = env.GITHUB_RUN_ATTEMPT;
  check(typeof id === 'string' && /^\d{5,18}$/.test(id) &&
    typeof attempt === 'string' && /^[1-9]\d{0,2}$/.test(attempt), 'invalid_run_identity');
  const dirname = `mcp-spec309-e2e-${id}-${attempt}`;
  const folder = `${ROOT}/${dirname}`;
  const filename = `sample-${id}-${attempt}.txt`;
  const file = `${folder}/${filename}`;
  const content = `OpenList MCP Spec309 disposable E2E ${id}-${attempt}\n`;

  async function mcp(name, args, expectsError = false) {
    let response;
    try { response = await transport(new Request(MCP, {
      method:'POST', redirect:'manual', signal:AbortSignal.timeout(18000),
      headers:{ authorization:'Bearer ' + env.MCP_ACCESS_TOKEN,
        'content-type':'application/json', accept:'application/json, text/event-stream' },
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',
        params:{name,arguments:args}}),
    })); } catch { stop('mcp_transport'); }
    check(response.status === 200 && !response.redirected &&
      !response.headers.has('location'), 'mcp_status');
    const rpc = await boundedJson(response);
    check(rpc?.jsonrpc === '2.0' && rpc.id === 1 &&
      !rpc.error && rpc.result &&
      (rpc.result.isError === true) === expectsError &&
      Array.isArray(rpc.result.content) && rpc.result.content.length === 1 &&
      rpc.result.content[0]?.type === 'text', 'mcp_contract');
    let body;
    try { body = JSON.parse(rpc.result.content[0].text); }
    catch { stop('mcp_invalid_result'); }
    check(body.operation === name, 'mcp_wrong_operation');
    if (!expectsError) check(body.status === 'succeeded' && body.code === 'OK', 'mcp_tool_failed');
    return body;
  }
  const initial = (await mcp('openlist_list_files', {path:ROOT,page:1,per_page:100})).observed_state;
  // Retained prior disposable runs are allowed, but ordinary user files,
  // incomplete pagination, forged children, and a reused run ID all block writes.
  // Nothing under an existing fixture is read, modified, or deleted.
  const fixtureName = /^mcp-spec309-e2e-\d{5,18}-[1-9]\d{0,2}$/;
  check(initial && Number.isSafeInteger(initial.total) && initial.total >= 0 &&
    initial.total <= 100 && Array.isArray(initial.entries) &&
    initial.entries.length === initial.total &&
    initial.entries.every(entry => entry && typeof entry.name === 'string' &&
      fixtureName.test(entry.name) && entry.is_dir === true &&
      (entry.path === undefined || entry.path === `${ROOT}/${entry.name}`)) &&
    new Set(initial.entries.map(entry => entry.name)).size === initial.entries.length &&
    !initial.entries.some(entry => entry.name === dirname), 'root_not_isolated');
  const created = await mcp('openlist_create_folder', {path:folder});
  check(created.target === folder && created.observed_state?.is_dir === true,
    'folder_unconfirmed');
  const folderMeta = (await mcp('openlist_get_file',{path:folder})).observed_state;
  check(folderMeta?.path === folder && folderMeta.name === dirname &&
    folderMeta.is_dir === true, 'folder_metadata');
  const before = (await mcp('openlist_list_files',{path:folder,page:1,per_page:100})).observed_state;
  check(before?.total === 0 && Array.isArray(before.entries) &&
    before.entries.length === 0, 'folder_not_empty');

  // Fixture only: fixed HTTPS endpoint, exact freshly created path, single PUT,
  // no overwrite intent, no retries, and no administrator metadata in output.
  let upload;
  try { upload = await transport(new Request(UPSTREAM, {
    method:'PUT', redirect:'manual', signal:AbortSignal.timeout(20000),
    headers:{ authorization:env.OPENLIST_API_TOKEN,
      'file-path':encodeURIComponent(file),
      'content-type':'text/plain; charset=utf-8' }, body:content,
  })); } catch { stop('fixture_write_unknown'); }
  if (upload.status !== 200 || upload.redirected || upload.headers.has('location'))
    stop('fixture_write_unknown');
  // Never retry even when the upstream responds with business failure.
  const uploadResult = await boundedJson(upload, 4096).catch(() => stop('fixture_write_unknown'));
  check(uploadResult?.code === 200, 'fixture_write_unknown');

  const meta = (await mcp('openlist_get_file',{path:file})).observed_state;
  check(meta?.path === file && meta.name === filename && meta.is_dir === false &&
    meta.size === new TextEncoder().encode(content).byteLength, 'file_metadata');
  const listing = (await mcp('openlist_list_files',{path:folder,page:1,per_page:100})).observed_state;
  check(listing?.total === 1 && listing.entries?.length === 1 &&
    listing.entries[0]?.name === filename, 'file_listing');
  const results = (await mcp('openlist_search_files',{
    parent:folder,keywords:`sample-${id}`,page:1,per_page:10,
  })).observed_state;
  check(Array.isArray(results?.entries) && results.entries.some(x => x.path === file),
    'search_missing_fixture');
  const read = (await mcp('openlist_read_text',{path:file})).observed_state;
  check(read?.path === file && read.text === content, 'read_text_mismatch');

  const outside = '/__openlist_e2e_prohibited';
  const denied = await mcp('openlist_create_folder', {path:outside}, true);
  check(denied.status === 'not_executed' && denied.code === 'OUT_OF_SCOPE',
    'out_of_scope_write_not_denied');
  return {folder:dirname, tested:['mkdir','get','list','search','read_text','scope_denial']};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runOpenListDriverAcceptance(process.env)
    .then(x => console.log(`OPENLIST_DRIVER_E2E_PASS folder=${x.folder} steps=${x.tested.length}`))
    .catch(error => {
      const safe = /^openlist_driver_e2e_[a-z0-9_]+$/.test(String(error?.message));
      console.error('OPENLIST_DRIVER_E2E_FAILED ' + (safe ? error.message : 'openlist_driver_e2e_unknown'));
      process.exitCode = 1;
    });
}
