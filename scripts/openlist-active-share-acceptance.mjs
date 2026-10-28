// Spec #309: explicit Owner-approved ONE-SHOT active synthetic share acceptance.
// No general share management and no user file mutations. This script is
// permitted only from the manual workflow with all other modes disabled.
// Sensitive share password and upstream payloads must never reach CI logs.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = '/Koofr/Downloads';
const FILE = ROOT + '/mcp-spec309-e2e-40493124967-1/sample-40493124967-1.txt';
const NAME = 'sample-40493124967-1.txt';
const MCP = 'https://openlist-mcp-worker.aiyaya.workers.dev/mcp';
const CREATE = 'https://openlist.lirtual.dpdns.org/api/share/create';
const PUBLIC = 'https://openlist.lirtual.dpdns.org/api/fs/get';
const CAP = 32768;
const fail = code => {throw Error('openlist_active_share_' + code)};
const check = (condition, code) => {if (!condition) fail(code)};

async function readJson(response) {
  const size = response.headers.get('content-length');
  check(!size || (/^[0-9]+$/.test(size) && Number(size) <= CAP), 'invalid_response');
  const reader = response.body?.getReader();
  check(reader, 'invalid_response');
  const chunks=[]; let count=0;
  try {
    for (;;) {
      const {value,done}=await reader.read();
      if(done) break;
      count+=value.byteLength;
      check(count<=CAP,'invalid_response');
      chunks.push(value);
    }
  } catch {fail('invalid_response')}
  finally {void reader.cancel().catch(()=>{})}
  const bytes=new Uint8Array(count);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
  let text;
  try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes)}
  catch{fail('invalid_response')}
  if(response.headers.get('content-type')?.split(';')[0]?.trim()==='text/event-stream'){
    const events=[...text.matchAll(/^data:\s*(\{.*\})\s*$/gm)];
    check(events.length===1,'invalid_response');
    text=events[0][1];
  } else check(response.headers.get('content-type')?.split(';')[0]?.trim()==='application/json',
    'invalid_response');
  try{return JSON.parse(text)}catch{fail('invalid_response')}
}
const safeSecret = value => typeof value==='string' && !!value && value.trim()===value &&
  !/[\r\n]/.test(value);

export async function runActiveShareAcceptance(env, transport=fetch,
  identity=()=>crypto.randomUUID(), random=bytes=>crypto.getRandomValues(bytes)) {
  check(env.OPENLIST_ACTIVE_SHARE_APPROVED==='true','not_approved');
  check(env.GITHUB_RUN_ATTEMPT==='1' && /^\d{5,18}$/.test(env.GITHUB_RUN_ID||''),
    'not_first_attempt');
  check(env.OPENLIST_HISTORICAL_SHARE_READ!=='true' && safeSecret(env.MCP_ACCESS_TOKEN) &&
    safeSecret(env.OPENLIST_API_TOKEN) &&
    env.MCP_ACCESS_TOKEN!==env.OPENLIST_API_TOKEN, 'invalid_credentials');
  let roots;
  try{roots=JSON.parse(env.OPENLIST_ALLOWED_ROOTS)}
  catch{fail('invalid_roots')}
  check(Array.isArray(roots) && roots.length===1 && roots[0]===ROOT,'invalid_roots');

  const uuid=identity();
  check(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(uuid),
    'invalid_identity');
  const id='mcp_spec309_live_'+uuid.replace(/-/g,'').slice(0,16);
  const secretBytes=random(new Uint8Array(32));
  check(secretBytes instanceof Uint8Array && secretBytes.length===32,'invalid_random');
  const pwd=Array.from(secretBytes,x=>x.toString(16).padStart(2,'0')).join('');
  const expires=new Date(Date.now()+3600_000).toISOString();
  let createDispatched=false, createConfirmed=false, disableDispatched=false;
  let beforePublic=false, publicAfterDisabled=false, beforeState=false, afterState=false;
  let disableMcpStatus='not_dispatched', publicRejection='not_tested', observedDelayMs=null;
  const limits={max_accessed:1,expires};
  const summary=()=>({id,createDispatched,createConfirmed,disableDispatched,
    disableMcpStatus,beforePublic,afterState,publicAfterDisabled,publicRejection,observedDelayMs});

  async function jsonPost(url, headers, payload, code) {
    let response;
    try {response=await transport(new Request(url,{
      method:'POST',redirect:'manual',signal:AbortSignal.timeout(18000),
      headers:{'content-type':'application/json',...headers},
      body:JSON.stringify(payload),
    }))} catch{fail(code)}
    check(response.status===200 && !response.redirected &&
      !response.headers.has('location'),code);
    try{return await readJson(response)}
    catch{fail(code)}
  }
  async function rpc(name,args) {
    const json=await jsonPost(MCP,{
      authorization:'Bearer '+env.MCP_ACCESS_TOKEN,
      accept:'application/json, text/event-stream',
    },{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}},
    'rpc_transport');
    check(json?.jsonrpc==='2.0' && json.id===1 && !json.error &&
      json.result && Array.isArray(json.result.content) &&
      json.result.content.length===1 && json.result.content[0]?.type==='text',
      'rpc_contract');
    let body;try{body=JSON.parse(json.result.content[0].text)}
    catch{fail('rpc_contract')}
    check(body?.operation===name,'rpc_contract');
    return {body,error:json.result.isError===true};
  }
  function exactShare(reply,disabled) {
    const b=reply.body;
    return !reply.error && b.status==='succeeded' && b.code==='OK' &&
      b.target===id && b.observed_state?.id===id &&
      b.observed_state?.disabled===disabled &&
      Array.isArray(b.observed_state.files) && b.observed_state.files.length===1 &&
      b.observed_state.files[0]===FILE &&
      b.observed_state.expires===expires && b.observed_state.max_accessed===1 &&
      Object.keys(b.observed_state).every(k=>
        ['id','files','disabled','expires','max_accessed'].includes(k));
  }
  async function getState() {return rpc('openlist_share_get',{id})}

  // Read-only preflight of the user-authorized historical *file*, not the
  // previously expired share. Do not modify any file or create directories.
  const file=await rpc('openlist_get_file',{path:FILE});
  check(!file.error && file.body.status==='succeeded' &&
    file.body.observed_state?.path===FILE && file.body.observed_state.name===NAME &&
    file.body.observed_state.is_dir===false &&
    file.body.observed_state.size===50,'fixture_not_exact');
  const absent=await getState();
  check(absent.error && absent.body.status==='not_executed' &&
    absent.body.code==='NOT_FOUND' && absent.body.target===id,
    'share_id_not_confirmed_absent');

  // ID is synthetic and is not sufficient to access the share; disclose it
  // for exact recovery if creation is uncertain, never the secret password.
  console.log('OPENLIST_ACTIVE_SHARE_TARGET id='+id);
  // One create dispatch. A transport failure is *unknown*, never retried.
  let createError=null;
  try {
    createDispatched=true;
    const created=await jsonPost(CREATE,{authorization:env.OPENLIST_API_TOKEN},
      {id,files:[FILE],pwd,expires,max_accessed:1,disabled:false},
      'create_unknown');
    check(created?.code===200,'create_unknown');
  } catch(e) {createError=e}
  // Read-only lookup can prove creation even when HTTP response was lost.
  for (let attempt=0;attempt<4;attempt++) {
    try {createConfirmed=exactShare(await getState(),false)}
    catch {createConfirmed=false}
    if(createConfirmed)break;
    if(attempt<3)await new Promise(resolve=>setTimeout(resolve,400));
  }
  if(!createConfirmed)fail('create_outcome_unknown');
  console.log('OPENLIST_ACTIVE_SHARE_CREATE_CONFIRMED id='+id);
  // From this point the *one known share* must be disabled even if a public
  // probe fails. No retry of either effectful operation is permitted.
  let probeError=createError;
  try {
    if(!probeError) {
      // Incorrect password must be refused without spending the single access.
      const wrong=await jsonPost(PUBLIC,{},
        {path:'/@s/'+id,password:'incorrect-test-password'},'public_probe_unknown');
      check(wrong?.code===400 && /password/i.test(String(wrong.message)),
        'public_wrong_password_not_denied');
      const granted=await jsonPost(PUBLIC,{},{path:'/@s/'+id,password:pwd},
        'public_probe_unknown');
      check(granted?.code===200 && granted.data?.name===NAME &&
        granted.data?.size===50 && granted.data?.is_dir===false,
        'public_access_not_proven');
      beforePublic=true;
      // The upstream counts successful public accesses with a background
      // saveDb operation. Give it time to settle before the explicit disable
      // to avoid racing an in-flight older share snapshot write.
      await new Promise(resolve=>setTimeout(resolve,1500));
      check(exactShare(await getState(),false),'public_pre_disable_state_unknown');
    }
  } catch(e) {probeError=e}

  // Exactly one call to existing deployed MCP; the MCP performs an additional
  // before/readback around one native /share/disable. Never repeat on unknown.
  const start=Date.now();
  let disableError=null;
  try {
    disableDispatched=true;
    console.log('OPENLIST_ACTIVE_SHARE_DISABLE_DISPATCH id='+id);
    const disabled=await rpc('openlist_share_disable',{id});
    disableMcpStatus=disabled.body?.status==='succeeded' &&
      disabled.body?.code==='OK' && !disabled.error ? 'succeeded' :
      disabled.body?.status==='unknown' ? 'unknown' : 'not_confirmed';
  } catch(e){disableError=e; disableMcpStatus='unknown'}
  // Independent reads only, bounded and no write retries. The max_accessed=1
  // may be consumed by the positive probe, so specifically require upstream's
  // "share has been disabled" rejection instead of a quota-denial false pass.
  for(let attempt=0;attempt<4;attempt++){
    try{afterState=exactShare(await getState(),true)}catch{}
    if(afterState) {
      observedDelayMs=Date.now()-start;break;
    }
    if(attempt<3)await new Promise(resolve=>setTimeout(resolve,400));
  }
  if(beforePublic) {
    for(let attempt=0;attempt<4;attempt++){
      try{
        const denied=await jsonPost(PUBLIC,{},{path:'/@s/'+id,password:pwd},
          'public_post_unknown');
        if(denied?.code===400 && /disabled/i.test(String(denied.message))){
          publicAfterDisabled=true;publicRejection='disabled';break;
        }
        publicRejection=denied?.code===400 && /access count/i.test(String(denied.message)) ?
          'quota_only':'other';
      }catch{publicRejection='unavailable'}
      if(attempt<3)await new Promise(resolve=>setTimeout(resolve,400));
    }
  }
  // No data or password, signed URLs, raw responses or headers in errors.
  console.log('OPENLIST_ACTIVE_SHARE_OUTCOME id='+id+
    ' readback_disabled='+afterState+' public_reject='+publicRejection+
    ' write_status='+disableMcpStatus);
  if(!afterState)fail('disable_readback_unknown');
  if(disableError || disableMcpStatus!=='succeeded')fail('disable_rpc_unknown');
  if(probeError)fail('public_probe_failed');
  if(!publicAfterDisabled)fail('public_disable_not_proven');
  return summary();
}

if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  runActiveShareAcceptance(process.env).then(result=>{
    console.log('OPENLIST_ACTIVE_SHARE_PASS id='+result.id+
      ' create_confirmed='+result.createConfirmed+
      ' disable_status='+result.disableMcpStatus+
      ' before_public='+result.beforePublic+
      ' disabled_readback='+result.afterState+
      ' public_reject='+result.publicRejection+
      ' observed_delay_ms='+result.observedDelayMs);
  }).catch(e=>{
    const code=/^openlist_active_share_[a-z0-9_]+$/.test(e?.message||'') ?
      e.message : 'openlist_active_share_unknown';
    console.error('OPENLIST_ACTIVE_SHARE_FAILED '+code);
    process.exitCode=1;
  });
}
