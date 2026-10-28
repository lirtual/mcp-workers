// One-time, exact-ID recovery for the *one* synthetic share created during #40625192631.
// No generic operation/ID inputs; only exact Owner-approved synthetic targets.
// No passwords, link signatures, upstream bodies or secrets reach CI logs.
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const ROOT='/Koofr/Downloads';
const RUN='40625192631';
const FILE=ROOT+'/mcp-spec309-e2e-'+RUN+'-1/sample-'+RUN+'-1.txt';
const SHARE='46fd942cb1c04310';
const MCP='https://openlist-mcp-worker.aiyaya.workers.dev/mcp';
const LIMIT=32768;
const fail=c=>{throw Error('openlist_recovery_'+c)};
const check=(ok,c)=>{if(!ok)fail(c)};

async function bodyJSON(res) {
  check(res.status===200 && !res.redirected && !res.headers.has('location'),'http');
  const len=res.headers.get('content-length');
  check(!len || (/^[0-9]+$/.test(len)&&Number(len)<=LIMIT),'response');
  let s='';try{s=await res.text()}catch{fail('response')}
  check(new TextEncoder().encode(s).length<=LIMIT,'response');
  const type=res.headers.get('content-type')?.split(';')[0]?.trim();
  if(type==='text/event-stream'){
    const lines=[...s.matchAll(/^data:\s*(\{.*\})\s*$/gm)];
    check(lines.length===1,'response');
    s=lines[0][1];
  } else check(type==='application/json','response');
  try{return JSON.parse(s)}catch{fail('response')}
}
export async function recover(env,transport=fetch,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))){
  check(env.OPENLIST_SPEC309_RECOVERY_APPROVED==='true' &&
    env.GITHUB_RUN_ATTEMPT==='1' && /^\d{5,18}$/.test(env.GITHUB_RUN_ID||''),
    'not_approved');
  check(env.OPENLIST_ALLOWED_ROOTS===JSON.stringify([ROOT]) &&
    typeof env.MCP_ACCESS_TOKEN==='string' && env.MCP_ACCESS_TOKEN.length>0 &&
    env.MCP_ACCESS_TOKEN===env.MCP_ACCESS_TOKEN.trim() &&
    !/[\r\n]/.test(env.MCP_ACCESS_TOKEN),'configuration');
  async function rpc(name,args){
    let res;try{
      res=await transport(new Request(MCP,{method:'POST',redirect:'manual',
        signal:AbortSignal.timeout(18000),
        headers:{authorization:'Bearer '+env.MCP_ACCESS_TOKEN,
          'content-type':'application/json',accept:'application/json, text/event-stream'},
        body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',
          params:{name,arguments:args}})}));
    }catch{fail('transport')}
    const data=await bodyJSON(res);
    check(data?.jsonrpc==='2.0'&&data.id===1&&!data.error&&
      Array.isArray(data.result?.content)&&data.result.content.length===1&&
      data.result.content[0].type==='text','contract');
    let b;try{b=JSON.parse(data.result.content[0].text)}catch{fail('contract')}
    check(b?.operation===name && b.target===(args.id??args.path),'contract');
    return {body:b,isError:data.result.isError===true};
  }
  const shared=b=>b?.id===SHARE && Array.isArray(b.files) &&
    b.files.length===1 && b.files[0]===FILE && typeof b.disabled==='boolean';
  async function readShare(){
    const v=await rpc('openlist_share_get',{id:SHARE});
    if(v.isError&&v.body.status==='not_executed'&&v.body.code==='NOT_FOUND')
      return null;
    check(!v.isError&&v.body.status==='succeeded'&&
      shared(v.body.observed_state),'share_unverified');
    return v.body.observed_state;
  }
  async function readFile(){
    const v=await rpc('openlist_get_file',{path:FILE});
    if(v.isError&&v.body.status==='not_executed'&&v.body.code==='NOT_FOUND')
      return null;
    const meta=v.body.observed_state;
    const expectedSize=new TextEncoder().encode(
      'OpenList MCP Spec309 disposable E2E '+RUN+'-1\n').byteLength;
    check(!v.isError && v.body.status==='succeeded' &&
      meta?.path===FILE&&meta.name===FILE.split('/').at(-1)&&
      meta.is_dir===false&&meta.size===expectedSize,'file_unverified');
    return meta;
  }
  // Guard both exact independently read objects before any mutation.
  // A share can initially be NOT_FOUND just after creation. Only classify
  // absent after bounded independent *read-only* rechecks.
  let existing=null;
  for(let i=0;i<8;i++){
    const state=await readShare();
    if(state){existing=state;break}
    if(i<7)await sleep(700);
  }
  const fixture=await readFile();
  check(fixture!==null,'fixture_absent_unexpected');
  // Share may already have disappeared; do not attempt a second revoke.
  if(existing && existing.disabled===false){
    console.log('OPENLIST_RECOVERY_DISABLING exact_share='+SHARE);
    const sent=await rpc('openlist_share_disable',{id:SHARE});
    // The native operation can succeed while immediate metadata read is stale.
    // Independently inspect rather than repeating the write, even on unknown.
    check(sent.body.status==='succeeded'||sent.body.status==='unknown'||
      sent.body.code==='ALREADY_DISABLED','disable_not_confirmed');
  }
  if(existing){
    let disabled=false,absent=false;
    for(let i=0;i<8;i++){
      const found=await readShare();
      if(found===null){absent=true;break}
      if(found.disabled===true){disabled=true;break}
      if(i<7)await sleep(700);
    }
    check(disabled||absent,'disable_readback_pending');
    if(disabled){
      console.log('OPENLIST_RECOVERY_DISABLED exact_share='+SHARE);
      // At most ONE native share-record revoke; no retry on unknown.
      const sent=await rpc('openlist_share_revoke',{id:SHARE});
      check(sent.body.status==='succeeded'||sent.body.status==='unknown',
        'revoke_not_confirmed');
      for(let i=0;i<8;i++){
        const found=await readShare();
        if(found===null){absent=true;break}
        check(found.disabled===true,'revoke_visible_unexpected');
        if(i<7)await sleep(700);
      }
      check(absent,'revoke_readback_pending');
    }
  }
  console.log('OPENLIST_RECOVERY_SHARE_ABSENT exact_share='+SHARE);
  // Even if share revoke succeeded, the source is separately rechecked.
  check(await readFile()!==null,'source_unexpected');
  // Delete exactly the newly-created fixture file, never a directory or old file.
  const removed=await rpc('openlist_delete',{path:FILE});
  check(removed.body.status==='succeeded'||removed.body.status==='unknown',
    'delete_not_confirmed');
  // After Koofr deletion, get_file can report UPSTREAM_UNAVAILABLE instead
  // of NOT_FOUND. Verify the exact new folder becomes empty instead.
  let absentFile=false;
  for(let i=0;i<8;i++){
    const {body:v,isError}=await rpc('openlist_list_files',{
      path:ROOT+'/mcp-spec309-e2e-'+RUN+'-1',page:1,per_page:100});
    check(!isError&&v.status==='succeeded'&&v.code==='OK',
      'file_listing_unverified');
    const state=v.observed_state;
    if(state?.total===0&&Array.isArray(state.entries)&&state.entries.length===0){
      absentFile=true;break;
    }
    check(state?.total===1&&state.entries?.length===1&&
      state.entries[0].name===FILE.split('/').at(-1),
      'file_listing_unexpected');
    if(i<7)await sleep(700);
  }
  check(absentFile,'file_absence_pending');
  console.log('OPENLIST_RECOVERY_PASS share_revoked=true synthetic_file_deleted=true');
  return {share_revoked:true,synthetic_file_deleted:true};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  recover(process.env).catch(e=>{
    const code=/^openlist_recovery_[a-z0-9_]+$/.test(e?.message||'')?
      e.message:'openlist_recovery_unknown';
    console.error('OPENLIST_RECOVERY_FAILED '+code);
    process.exitCode=1;
  });
}
