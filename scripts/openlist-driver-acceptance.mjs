// Explicit, manual disposable-driver E2E; does not deploy or register a Portal.
// Any error returns only a stable code: never log tokens, file contents, or upstream bodies.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const ROOT = '/Koofr/Downloads';
const MCP = 'https://openlist-mcp-worker.aiyaya.workers.dev/mcp';
const UPSTREAM = 'https://openlist.lirtual.dpdns.org/api/fs/put';

function stop(code) { throw Error('openlist_driver_e2e_' + code); }
function check(condition, code) { if (!condition) stop(code); }

// Only constant classifications reach CI output. Tool messages, file paths,
// opaque identifiers and upstream bodies must never be interpolated into logs.
const SAFE_TOOL_ERROR_CODES = new Set([
  'OUT_OF_SCOPE', 'INVALID_PATH', 'INVALID_INPUT', 'UNAUTHORIZED',
  'NOT_FOUND', 'NOT_SUPPORTED', 'CONFLICT', 'UPSTREAM_REJECTED',
  'UPSTREAM_UNAVAILABLE', 'UPSTREAM_UNCERTAIN', 'CONFIGURATION_ERROR',
  'LIMIT_EXCEEDED',
]);
function stopToolFailure(name, body) {
  const status = ['not_executed', 'unknown', 'failed'].includes(body.status)
    ? body.status : 'unclassified';
  const code = SAFE_TOOL_ERROR_CODES.has(body.code)
    ? body.code.toLowerCase() : 'unclassified';
  stop(`${name}_${status}_${code}`);
}

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
  check(!env.OPENLIST_NATIVE_E2E_APPROVED ||
    ['true', 'false'].includes(env.OPENLIST_NATIVE_E2E_APPROVED),
    'native_approval_invalid');
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
      (rpc.result.isError === undefined || typeof rpc.result.isError === 'boolean') &&
      Array.isArray(rpc.result.content) && rpc.result.content.length === 1 &&
      rpc.result.content[0]?.type === 'text', 'mcp_contract');
    let body;
    try { body = JSON.parse(rpc.result.content[0].text); }
    catch { stop('mcp_invalid_result'); }
    check(body && typeof body === 'object' && !Array.isArray(body) &&
      body.operation === name, 'mcp_wrong_operation');
    // Classify an unexpected MCP tool error before the expected-success
    // isError check. The previous ordering hid native write failures as
    // a generic mcp_contract error. Never retry an unknown write.
    if (!expectsError && rpc.result.isError === true) stopToolFailure(name, body);
    check((rpc.result.isError === true) === expectsError, 'mcp_contract');
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
  // An immediately cached empty listing can lag a confirmed fixture upload.
  // Retry only the read, briefly and with a hard bound; never repeat a write.
  // Any unexpected entry or malformed listing still fails closed immediately.
  let listing;
  for (let attempt = 0; attempt < 4; attempt++) {
    listing = (await mcp('openlist_list_files',
      {path:folder,page:1,per_page:100})).observed_state;
    if (listing?.total === 1 && listing.entries?.length === 1 &&
        listing.entries[0]?.name === filename) break;
    check(listing?.total === 0 && Array.isArray(listing.entries) &&
      listing.entries.length === 0 && listing.page === 1, 'file_listing');
    if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 1000));
  }
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

  const tested = ['mkdir','get','list','search','read_text','scope_denial'];
  if (env.OPENLIST_NATIVE_E2E_APPROVED === 'true') {
    // Uses only paths generated for this run, never existing user or retained
    // test data. The selected main must already be manually deployed.
    const native = `${folder}/native-${id}-${attempt}.txt`;
    const destinationDir = `${folder}/native-copies`;
    const moved = `${destinationDir}/native-${id}-${attempt}.txt`;
    const renamed = `${destinationDir}/renamed-${id}-${attempt}.txt`;
    const nativeContent = `OpenList native MCP E2E ${id}-${attempt}\n`;
    const upload = await mcp('openlist_upload_small',
      {path:native,content:nativeContent,encoding:'utf8'});
    check(upload.target === native && upload.observed_state?.size ===
      new TextEncoder().encode(nativeContent).byteLength &&
      upload.observed_state?.native_may_overwrite === true, 'native_upload');
    const dest = await mcp('openlist_create_folder',{path:destinationDir});
    check(dest.target === destinationDir && dest.observed_state?.is_dir === true,
      'native_dest_create');
    const emptyDest = (await mcp('openlist_list_files',
      {path:destinationDir,page:1,per_page:100})).observed_state;
    check(emptyDest?.total === 0 && Array.isArray(emptyDest.entries) &&
      emptyDest.entries.length === 0, 'native_dest_not_empty');
    const copied = await mcp('openlist_copy',{path:native,destination_dir:destinationDir});
    check(copied.observed_state?.destination === moved &&
      copied.observed_state?.native_may_overwrite === true, 'native_copy');
    const renamedResult = await mcp('openlist_rename',
      {path:moved,new_name:`renamed-${id}-${attempt}.txt`});
    check(renamedResult.observed_state?.destination === renamed, 'native_rename');
    const movedResult = await mcp('openlist_move',
      {path:native,destination_dir:destinationDir});
    check(movedResult.observed_state?.destination === moved &&
      movedResult.observed_state?.native_may_overwrite === true, 'native_move');
    for (const target of [moved,renamed]) {
      const contentResult = (await mcp('openlist_read_text',{path:target})).observed_state;
      check(contentResult?.path === target && contentResult.text === nativeContent,
        'native_file_mismatch');
    }
    const signed = (await mcp('openlist_download_link',{path:moved})).observed_state;
    // The signed URL is bearer-sensitive; never write it to logs, artifacts
    // or the returned summary. Existing link_expiration=0 is not short-lived.
    let parsed;
    try { parsed = new URL(signed?.url); } catch { stop('native_link_invalid'); }
    check(parsed.origin === 'https://openlist.lirtual.dpdns.org' &&
      parsed.pathname === '/api/p/' + moved.slice(1).split('/').map(encodeURIComponent).join('/') &&
      typeof parsed.searchParams.get('sign') === 'string' &&
      parsed.searchParams.get('sign').length > 0 &&
      typeof signed.permanent === 'boolean' &&
      (signed.permanent ? signed.expires_at === null :
        typeof signed.expires_at === 'string'), 'native_link_invalid');
    // Verify the actual signed public route with a tiny exact synthetic file,
    // not just the URL's appearance. No credential is forwarded or logged.
    let publicResponse;
    try {
      publicResponse = await transport(new Request(signed.url,{
        method:'GET',redirect:'manual',signal:AbortSignal.timeout(15000),
        headers:{ accept:'text/plain' },
      }));
    } catch { stop('native_link_transport'); }
    check(publicResponse.status === 200 && !publicResponse.redirected &&
      !publicResponse.headers.has('location'), 'native_link_status');
    let publicBytes;
    try {
      const reader=publicResponse.body?.getReader();
      check(reader,'native_link_body');
      const chunks=[];let total=0;
      for (;;) {
        const {done,value}=await reader.read();
        if (done) break;
        total+=value.byteLength;
        check(total<=4096,'native_link_oversize');
        chunks.push(value);
      }
      publicBytes=new Uint8Array(total);let offset=0;
      for(const chunk of chunks) {publicBytes.set(chunk,offset);offset+=chunk.length;}
    } catch {stop('native_link_body');}
    let publicText;
    try { publicText=new TextDecoder('utf-8',{fatal:true}).decode(publicBytes); }
    catch { stop('native_link_invalid_utf8'); }
    check(publicText===nativeContent,'native_link_content');
    const forbiddenNative = await mcp('openlist_move',{
      path:'/__openlist_e2e_prohibited/file.txt',destination_dir:destinationDir},true);
    check(forbiddenNative.status === 'not_executed' &&
      forbiddenNative.code === 'OUT_OF_SCOPE','native_scope_denial');
    tested.push('upload_small','copy','rename','move','read_native_text',
      'signed_download_link','native_scope_denial');
  }
  return {folder:dirname, tested};

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
