// One preapproved, expiring synthetic share proof; no user file or general share writes.
// Run only via manual main workflow after an authorized Worker release.
// Never print credentials, share password, upstream bodies or URL.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const URL_MCP='https://openlist-mcp-worker.aiyaya.workers.dev/mcp';
const ID='mcp_spec309_40493124967_1';
const FILE='/Koofr/Downloads/mcp-spec309-e2e-40493124967-1/sample-40493124967-1.txt';
function stop(code){throw Error('openlist_share_acceptance_'+code);}
function check(value,code){if(!value)stop(code);}

async function limitedJson(response) {
  check(response.status===200&&!response.redirected&&!response.headers.has('location'),'transport_denied');
  const h=response.headers.get('content-length');
  check(h===null||(/^\d+$/.test(h)&&Number(h)<=32768),'limit');
  const text=await response.text();
  check(new TextEncoder().encode(text).byteLength<=32768,'limit');
  let value;
  try{
    const content=response.headers.get('content-type')?.split(';')[0]?.trim();
    if(content==='application/json')value=JSON.parse(text);
    else if(content==='text/event-stream'){
      const events=[...text.matchAll(/^data:\s*(\{.*\})\s*$/gm)];
      check(events.length===1,'invalid_sse');
      value=JSON.parse(events[0][1]);
    } else stop('content_type');
  }catch{stop('invalid_json');}
  check(value?.jsonrpc==='2.0'&&value.id===1&&!value.error&&
    value.result&&Array.isArray(value.result.content)&&
    value.result.content.length===1&&value.result.content[0]?.type==='text','rpc');
  let data;
  try{data=JSON.parse(value.result.content[0].text);}catch{stop('tool_json');}
  return {data,isError:value.result.isError===true};
}

export async function runOpenListOneShotShareAcceptance(env,transport=fetch){
  check(env.OPENLIST_SHARE_ACCEPTANCE_APPROVED==='true','not_approved');
  check(typeof env.MCP_ACCESS_TOKEN==='string'&&env.MCP_ACCESS_TOKEN.length>0&&
    env.MCP_ACCESS_TOKEN.trim()===env.MCP_ACCESS_TOKEN&&
    !/[\r\n]/.test(env.MCP_ACCESS_TOKEN),'missing_token');
  let roots;
  try{roots=JSON.parse(env.OPENLIST_ALLOWED_ROOTS);}catch{stop('roots');}
  check(Array.isArray(roots)&&roots.length===1&&roots[0]==='/Koofr/Downloads','roots');
  async function call(name,args={}){
    let response;
    try{response=await transport(new Request(URL_MCP,{method:'POST',redirect:'manual',
      signal:AbortSignal.timeout(18000),headers:{
        authorization:'Bearer '+env.MCP_ACCESS_TOKEN,
        'content-type':'application/json',accept:'application/json, text/event-stream'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}));}
    catch{stop('transport_unknown');}
    const value=await limitedJson(response);
    check(!value.isError&&value.data.operation===name&&
      value.data.status==='succeeded'&&value.data.code==='OK','tool_not_confirmed');
    return value.data;
  }
  // This is intentionally the ONLY dispatch of the effectful creation call.
  // An uncertain result fails closed and must never be retried automatically.
  const created=await call('openlist_share_create');
  check(created.target===ID&&created.observed_state?.id===ID&&
    created.observed_state.files?.length===1&&created.observed_state.files[0]===FILE&&
    created.observed_state.disabled===false&&
    created.observed_state.max_accessed===1&&
    Date.parse(created.observed_state.expires)>Date.now(),'create_evidence');
  const found=await call('openlist_share_get',{id:ID});
  check(found.target===ID&&found.observed_state?.id===ID&&
    found.observed_state.files?.length===1&&found.observed_state.files[0]===FILE&&
    found.observed_state.disabled===false&&found.observed_state.max_accessed===1&&
    found.observed_state.expires===created.observed_state.expires,'get_mismatch');
  return {id:ID,expires:found.observed_state.expires};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  runOpenListOneShotShareAcceptance(process.env)
    .then(()=>console.log('OPENLIST_ONE_SHOT_SHARE_ACCEPTANCE_PASS'))
    .catch(error=>{
      const code=String(error?.message??'');
      console.error('OPENLIST_ONE_SHOT_SHARE_ACCEPTANCE_FAILED',
        /^openlist_share_acceptance_[a-z0-9_]+$/.test(code)?code:'openlist_share_acceptance_unknown');
      process.exitCode=1;
    });
}
