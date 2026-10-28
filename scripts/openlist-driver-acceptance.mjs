// Explicit, manual disposable-driver E2E; does not deploy or register a Portal.
// Any error returns only a stable code: never log tokens, file contents, or upstream bodies.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const ROOT = '/Koofr/Downloads';
const MCP = 'https://openlist-mcp-worker.aiyaya.workers.dev/mcp';
const UPSTREAM = 'https://openlist.lirtual.dpdns.org/api/fs/put';
const UPSTREAM_LIST = 'https://openlist.lirtual.dpdns.org/api/fs/list';
const UPSTREAM_GET = 'https://openlist.lirtual.dpdns.org/api/fs/get';

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
  check(!env.OPENLIST_HIGH_RISK_E2E_APPROVED ||
    ['true','false'].includes(env.OPENLIST_HIGH_RISK_E2E_APPROVED),
    'high_risk_approval_invalid');
  check(env.OPENLIST_HIGH_RISK_E2E_APPROVED !== 'true' ||
    (env.OPENLIST_DRIVER_E2E_APPROVED === 'true' &&
      env.OPENLIST_NATIVE_E2E_APPROVED !== 'true' &&
      env.GITHUB_RUN_ATTEMPT === '1'), 'high_risk_approval_invalid');
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
    // Policy acceptance: the native signer can legitimately return a permanent
    // signature. MCP must reject it instead of exposing a bearer URL.
    if (expectsError === 'read-or-not-found') {
      check((rpc.result.isError === true &&
        body.status === 'not_executed' && body.code === 'NOT_FOUND') ||
        (rpc.result.isError !== true &&
          body.status === 'succeeded' && body.code === 'OK'),
        'mcp_read_contract');
    } else if (expectsError === 'policy-denial') {
      if (rpc.result.isError === true)
        check(body.status === 'not_executed' && body.code === 'NOT_SUPPORTED',
          'native_link_policy');
      else
        check(body.status === 'succeeded' && body.code === 'OK',
          'native_link_policy');
    } else {
      if (!expectsError && rpc.result.isError === true) stopToolFailure(name, body);
      check((rpc.result.isError === true) === expectsError, 'mcp_contract');
      if (!expectsError) check(body.status === 'succeeded' && body.code === 'OK', 'mcp_tool_failed');
    }
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
  // A cached empty directory can outlive a confirmed upload. Upstream /list
  // accepts refresh:true; use it once, only for this freshly created fixture,
  // after an exactly empty MCP listing. Never repeat a file mutation.
  let listing = (await mcp('openlist_list_files',
    {path:folder,page:1,per_page:100})).observed_state;
  if (listing?.total === 0 && listing.page === 1 &&
      Array.isArray(listing.entries) && listing.entries.length === 0) {
    let refreshed;
    try {
      refreshed = await transport(new Request(UPSTREAM_LIST, {
        method:'POST', redirect:'manual', signal:AbortSignal.timeout(12000),
        headers:{ authorization:env.OPENLIST_API_TOKEN,
          'content-type':'application/json' },
        body:JSON.stringify({path:folder,page:1,per_page:100,refresh:true}),
      }));
    } catch { stop('file_listing_refresh_unknown'); }
    check(refreshed.status === 200 && !refreshed.redirected &&
      !refreshed.headers.has('location'), 'file_listing_refresh_unknown');
    const refreshedResult = await boundedJson(refreshed, 8192)
      .catch(() => stop('file_listing_refresh_unknown'));
    check(refreshedResult?.code === 200, 'file_listing_refresh_unknown');
    // Refresh is a read-only cache invalidation, not permission to create
    // more files or to weaken the exact one-file confirmation.
    // An upstream refresh may finish before Cloudflare's independent reads
    // observe the new directory entry. Wait a bounded 10 reads rather than
    // issuing another upload or accepting a merely stale empty listing.
    for (let attempt = 0; attempt < 10; attempt++) {
      listing = (await mcp('openlist_list_files',
        {path:folder,page:1,per_page:100})).observed_state;
      if (listing?.total === 1 && listing.entries?.length === 1 &&
          listing.entries[0]?.name === filename) break;
      check(listing?.total === 0 && listing.page === 1 &&
        Array.isArray(listing.entries) && listing.entries.length === 0,
        'file_listing');
      if (attempt < 9) await new Promise(resolve => setTimeout(resolve, 1000));
    }
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
    const linkReply = await mcp('openlist_download_link',{path:moved},'policy-denial');
    let linkCheck;
    if (linkReply.status === 'not_executed' && linkReply.code === 'NOT_SUPPORTED') {
      // Verify the actual native signer is permanent; otherwise an unrelated
      // NOT_SUPPORTED error must not silently count as a policy acceptance.
      let upstream;
      try {
        upstream = await transport(new Request(UPSTREAM_GET,{
          method:'POST',redirect:'manual',signal:AbortSignal.timeout(12000),
          headers:{authorization:env.OPENLIST_API_TOKEN,
            'content-type':'application/json'},
          body:JSON.stringify({path:moved}),
        }));
      } catch { stop('native_link_signer_unavailable'); }
      check(upstream.status === 200 && !upstream.redirected &&
        !upstream.headers.has('location'), 'native_link_signer_unavailable');
      const native = await boundedJson(upstream, 8192)
        .catch(() => stop('native_link_signer_unavailable'));
      check(native?.code === 200 && native.data?.name === moved.split('/').at(-1) &&
        (native.data?.path === undefined || native.data.path === moved) &&
        native.data?.is_dir === false &&
        /^0\.[a-f0-9]{64}$/.test(native.data?.sign),
        'native_link_policy_unverified');
      linkCheck = 'permanent_signed_link_refused';
    } else {
      check(linkReply.status === 'succeeded' && linkReply.code === 'OK',
        'native_link_policy');
      const signed = linkReply.observed_state;

      // The signed URL is bearer-sensitive; never print it to logs or artifacts.
      let parsed;
      try { parsed = new URL(signed?.url); } catch { stop('native_link_invalid'); }
      check(parsed.origin === 'https://openlist.lirtual.dpdns.org' &&
        parsed.pathname === '/api/p/' + moved.slice(1).split('/').map(encodeURIComponent).join('/') &&
        typeof parsed.searchParams.get('sign') === 'string' &&
        parsed.searchParams.get('sign').length > 0 &&
        signed.permanent === false &&
        typeof signed.expires_at === 'string' &&
        Number.isFinite(Date.parse(signed.expires_at)) &&
        Date.parse(signed.expires_at) > Date.now(), 'native_link_invalid');
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
      linkCheck = 'finite_signed_download_link';
    }
    const forbiddenNative = await mcp('openlist_move',{
      path:'/__openlist_e2e_prohibited/file.txt',destination_dir:destinationDir},true);
    check(forbiddenNative.status === 'not_executed' &&
      forbiddenNative.code === 'OUT_OF_SCOPE','native_scope_denial');
    tested.push('upload_small','copy','rename','move','read_native_text',
      linkCheck,'native_scope_denial');
  }

  if (env.OPENLIST_HIGH_RISK_E2E_APPROVED === 'true') {
    // Every target is scoped to the *new folder and file of THIS first-attempt
    // manual run*. No historical fixture, user object or directory is deleted.
    // Never retry a write after any unknown result.
    const exactFile = file;
    const exactSize = new TextEncoder().encode(content).byteLength;
    const original = (await mcp('openlist_get_file',{path:exactFile})).observed_state;
    check(original?.path === exactFile && original.name === filename &&
      original.is_dir === false && original.size === exactSize,
      'high_risk_file_preflight');
    const outOfScope = await mcp('openlist_delete',{
      path:'/__openlist_e2e_prohibited/synthetic-file.txt'},true);
    check(outOfScope.status==='not_executed' && outOfScope.code==='OUT_OF_SCOPE',
      'high_risk_out_of_scope_delete');
    const invalidShare = await mcp('openlist_share_create',{
      files:['/__openlist_e2e_prohibited/synthetic-file.txt'],
      expires_hours:1,max_accessed:3},true);
    check(invalidShare.status==='not_executed' &&
      invalidShare.code==='OUT_OF_SCOPE','high_risk_out_of_scope_share');
    const wrongUpdate=await mcp('openlist_share_update',{
      id:'mcp_spec309_no_such_share',expires_hours:2},true);
    check(wrongUpdate.status==='not_executed' && wrongUpdate.code==='NOT_FOUND',
      'high_risk_unknown_share_not_mutated');

    const createdShare=await mcp('openlist_share_create',{
      files:[exactFile],expires_hours:1,max_accessed:3,
    });
    const newId=createdShare.target;
    const password=createdShare.observed_state?.password_once;
    // Only a verified share identity and exact file grant permission to
    // perform fail-safe cleanup; never act on an unrelated returned ID.
    check(typeof newId==='string' && /^[a-f0-9]{16}$/.test(newId) &&
      createdShare.observed_state?.id===newId &&
      JSON.stringify(createdShare.observed_state?.files)===JSON.stringify([exactFile]),
      'high_risk_create_uncertain');
    let disableDispatched=false, revokeDispatched=false;
    async function readOwnedShare(){
      const state=await mcp('openlist_share_get',{id:newId},'read-or-not-found');
      if(state.status==='not_executed' && state.code==='NOT_FOUND')return null;
      check(state.status==='succeeded' &&
        state.observed_state?.id===newId &&
        JSON.stringify(state.observed_state.files)===JSON.stringify([exactFile]) &&
        typeof state.observed_state.disabled==='boolean',
        'high_risk_share_identity');
      return state.observed_state;
    }
    try {
    // A malformed one-time password or metadata is a *post-creation* failure;
    // the owned synthetic share still needs protective disable/revoke.
    check(/^[a-f0-9]{48}$/.test(password) &&
      createdShare.observed_state?.disabled===false &&
      createdShare.observed_state?.max_accessed===3 &&
      typeof createdShare.observed_state?.expires==='string',
      'high_risk_create_uncertain');
    console.log('OPENLIST_HIGH_RISK_CREATED id='+newId);
    // The first independent read may be NOT_FOUND just after a successful
    // creation due to cache visibility. Retry only the *read*, never create.
    let initialShare=null;
    for(let i=0;i<10;i++){
      const state=await readOwnedShare();
      if(state?.disabled===false && state.max_accessed===3){
        initialShare=state;break;
      }
      if(state && (state.disabled!==false || state.max_accessed!==3))
        stop('high_risk_create_readback_mismatch');
      if(i<9)await new Promise(resolve=>setTimeout(resolve,750));
    }
    check(initialShare!==null,'high_risk_create_readback');
    const update=await mcp('openlist_share_update',{
      id:newId,expires_hours:2,max_accessed:4,
    });
    check(update.observed_state?.id===newId &&
      update.observed_state?.max_accessed===4 &&
      JSON.stringify(update.observed_state?.files)===JSON.stringify([exactFile]),
      'high_risk_update');
    // Cloudflare upstream persisted share changes can appear after a bounded
    // read-only propagation delay. Never repeat the update itself.
    let updated;
    for(let i=0;i<8;i++){
      updated=(await mcp('openlist_share_get',{id:newId})).observed_state;
      if(updated?.max_accessed===4 && updated.disabled===false &&
        typeof updated.expires==='string' && updated.expires!==initialShare.expires)break;
      if(i<7)await new Promise(resolve=>setTimeout(resolve,700));
    }
    check(updated?.max_accessed===4 && updated.disabled===false &&
      typeof updated.expires==='string' && updated.expires!==initialShare.expires,
      'high_risk_update_readback');

    async function publicShare(expected) {
      let response;
      try {
        response=await transport(new Request('https://openlist.lirtual.dpdns.org/api/fs/get',{
          method:'POST',redirect:'manual',signal:AbortSignal.timeout(16000),
          headers:{'content-type':'application/json'},
          body:JSON.stringify({path:'/@s/'+newId,password}),
        }));
      } catch {stop('high_risk_public_transport')}
      check((response.status===200 || response.status===400) &&
        !response.redirected && !response.headers.has('location'),
        'high_risk_public_status');
      const body=await boundedJson(response,8192);
      if(expected==='allowed')
        check(response.status===200 && body.code===200 &&
          body.data?.name===filename && body.data?.size===exactSize &&
          body.data?.is_dir===false,'high_risk_public_not_allowed');
      else
        check(response.status===400 && body.code===400 &&
          /disabled/i.test(String(body.message)),
          'high_risk_public_not_disabled');
    }
    // Unauthenticated public access proves a newly created public share was
    // active, and that disabling it controls access (not merely quota exhaustion).
    await publicShare('allowed');
    await new Promise(resolve=>setTimeout(resolve,1200));
    disableDispatched=true;
    const disabled=await mcp('openlist_share_disable',{id:newId});
    check(disabled.observed_state?.disabled===true,'high_risk_disable');
    let afterDisabled;
    for(let i=0;i<8;i++){
      afterDisabled=(await mcp('openlist_share_get',{id:newId})).observed_state;
      if(afterDisabled?.disabled===true)break;
      if(i<7)await new Promise(resolve=>setTimeout(resolve,700));
    }
    check(afterDisabled?.disabled===true,'high_risk_disable_readback');
    await publicShare('disabled');
    // A later enable starts a NEW publicly accessible period. Permit exactly
    // one fresh safety-disable in its own failure path, but never replay the
    // earlier disable for the prior period.
    disableDispatched=false;
    const enabled=await mcp('openlist_share_enable',{id:newId});
    check(enabled.observed_state?.disabled===false,'high_risk_enable');
    let afterEnabled;
    for(let i=0;i<8;i++){
      afterEnabled=(await mcp('openlist_share_get',{id:newId})).observed_state;
      if(afterEnabled?.disabled===false&&afterEnabled.max_accessed===4)break;
      if(i<7)await new Promise(resolve=>setTimeout(resolve,700));
    }
    check(afterEnabled?.disabled===false&&afterEnabled.max_accessed===4,
      'high_risk_enable_readback');
    await publicShare('allowed');
    await new Promise(resolve=>setTimeout(resolve,1200));
    // Make the newly enabled share non-public AGAIN *before* revoking its
    // record. If revoke fails or is uncertain, it must not remain enabled.
    // This is a separate enabled→disabled transition, NOT a retry of the
    // earlier disabled→enabled→disabled lifecycle.
    const safeDisabled=await mcp('openlist_share_disable',{id:newId});
    check(safeDisabled.observed_state?.disabled===true,'high_risk_final_disable');
    let finalDisabled=false;
    for(let i=0;i<8;i++){
      const state=(await mcp('openlist_share_get',{id:newId})).observed_state;
      if(state?.id===newId && state.disabled===true){
        finalDisabled=true;break;
      }
      if(i<7)await new Promise(resolve=>setTimeout(resolve,700));
    }
    check(finalDisabled,'high_risk_final_disable_readback');
    await publicShare('disabled');
    revokeDispatched=true;
    const revoke=await mcp('openlist_share_revoke',{id:newId});
    check(revoke.observed_state?.revoked===true,'high_risk_revoke');
    let shareGone=false;
    for(let i=0;i<8;i++){
      const absent=await mcp('openlist_share_get',{id:newId},'read-or-not-found');
      if(absent.status==='not_executed'&&absent.code==='NOT_FOUND'){
        shareGone=true;break;
      }
      check(absent.observed_state?.id===newId &&
        JSON.stringify(absent.observed_state.files)===JSON.stringify([exactFile]) &&
        absent.observed_state.disabled===true,
        'high_risk_revoke_readback_unexpected_share');
      if(i<7)await new Promise(resolve=>setTimeout(resolve,700));
    }
    check(shareGone,'high_risk_revoke_readback');
    const preserved=(await mcp('openlist_get_file',{path:exactFile})).observed_state;
    check(preserved?.path===exactFile && preserved.is_dir===false &&
      preserved.size===exactSize,'high_risk_revoke_preserved_file');
    const deleted=await mcp('openlist_delete',{path:exactFile});
    check(deleted.observed_state?.deleted===true && deleted.target===exactFile,
      'high_risk_delete');
    // Native Koofr get_file may classify a removed path as UPSTREAM_UNAVAILABLE
    // rather than NOT_FOUND. Verify only the original now-empty directory;
    // do not repeat deletion or treat generic get errors as proof.
    let empty=false;
    for(let i=0;i<8;i++){
      const listing=(await mcp('openlist_list_files',{
        path:folder,page:1,per_page:100})).observed_state;
      if(listing?.total===0 && listing.entries?.length===0){empty=true;break}
      check(listing?.total===1 && listing.entries?.length===1 &&
        listing.entries[0].name===filename,'high_risk_delete_listing');
      if(i<7)await new Promise(resolve=>setTimeout(resolve,700));
    }
    check(empty,'high_risk_delete_readback');
    } catch (error) {
      // When any post-create check fails, immediately attempt at most one
      // disable and one revoke of ONLY the exact newly created share. This
      // is a separate authorized safety cleanup, never a retry of an unknown
      // update/disable/revoke. The new fixture file is kept for diagnosis.
      console.log('OPENLIST_HIGH_RISK_FAILSAFE share_id='+newId);
      if(!revokeDispatched) {
        // A just-created share can temporarily look absent. Observe ONLY
        // this verified ID for a bounded period; no write retries.
        let safe=false,absent=false;
        try {
          for(let i=0;i<10;i++){
            const state=await readOwnedShare();
            if(state?.disabled===true){safe=true;break}
            if(state===null){
              if(i<9)await new Promise(resolve=>setTimeout(resolve,750));
              else absent=true;
              continue;
            }
            if(!disableDispatched) {
              disableDispatched=true;
              try {await mcp('openlist_share_disable',{id:newId});}catch{}
            }
            if(i<9)await new Promise(resolve=>setTimeout(resolve,750));
          }
          // Revoke only an independently verified disabled record, never
          // an unconfirmed active share after an ambiguous disable.
          if(safe) {
            revokeDispatched=true;
            try {await mcp('openlist_share_revoke',{id:newId});}catch{}
          } else if(absent) {
            console.log('OPENLIST_HIGH_RISK_FAILSAFE_NOT_VISIBLE share_id='+newId);
          } else {
            console.log('OPENLIST_HIGH_RISK_FAILSAFE_UNCONFIRMED share_id='+newId);
          }
        } catch {
          console.log('OPENLIST_HIGH_RISK_FAILSAFE_UNCONFIRMED share_id='+newId);
        }
      }
      throw error;
    }
    console.log('OPENLIST_HIGH_RISK_E2E_PASS share_id='+newId+
      ' share_revoked=true source_deleted=true');
    tested.push('share_create','share_update','share_disable',
      'share_enable','share_revoke','single_file_delete','public_access');
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
