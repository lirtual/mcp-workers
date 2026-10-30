// Read-only publication gate: distinguish first legacy-to-ACTIONS binding
// transition from subsequent compatible Workflow code releases.
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const fail=(reason)=>{throw Error('Workflow Actions cutover blocked: '+reason);};
export function verifyActionsCutoverReadback(currentBindings,rawD1){
 if(!Array.isArray(currentBindings))fail('existing runtime bindings unavailable');
 const serviceNames=currentBindings.filter(x=>x?.type==='service').map(x=>x.name);
 const old=['WEIXIN_ACTION_PROVIDER','BARK_ACTION_PROVIDER'];
 const oldCount=old.filter(n=>serviceNames.includes(n)).length;
 const unified=serviceNames.includes('ACTIONS');
 if(oldCount===0&&!unified)fail('no known action service binding');
 if(oldCount>0&&unified)fail('ambiguous mixed binding topology');
 if(oldCount>0&&oldCount!==2)fail('partial legacy provider inventory');
 const expected=oldCount>0?[
  ['WEIXIN_ACTION_PROVIDER','weixin-mcp-worker','WeixinActionProvider'],
  ['BARK_ACTION_PROVIDER','bark-provider','BarkActionProvider']
 ]:[['ACTIONS','cloudflare-actions','ActionsEntrypoint']];
 for(const [name,service,entrypoint] of expected){
  const matches=currentBindings.filter(x=>x?.name===name);
  if(matches.length!==1||matches[0]?.type!=='service'||
     matches[0].service!==service||matches[0].entrypoint!==entrypoint)
    fail('reviewed service binding topology drift');
 }
 if(!Array.isArray(rawD1)||rawD1.length!==1||rawD1[0]?.success!==true||
    rawD1[0]?.results?.length!==1)fail('D1 fence read unavailable');
 const gate=rawD1[0].results[0];
 if(!['open','frozen'].includes(gate?.gate_state))fail('D1 fence row missing');
 if(oldCount>0&&gate.gate_state!=='frozen')fail('old-to-new binding needs frozen D1 fence');
 // This only verifies the database gate. An old native instance that does
 // not implement it MUST be physically drained in a separate hard gate.
 return {transition:oldCount>0?'legacy_to_unified':'already_unified',
  gate:gate.gate_state,physical_drain_proven:false};
}
// A read-only D1/native snapshot cannot prove that an old ingress is blocked.
// Owner's separately authorized, externally performed ingress quiescence is
// an explicit prerequisite, not something this script silently assumes.
export function requireOldIngressQuiescence(value){
 if(value!=='true')fail('first cutover requires independently verified old ingress quiescence');
 return true;
}
// Native instances retain their originally compiled Workflow version.
// A D1 fence in NEW source cannot stop dispatch by a still-live OLD instance.
// Only a bounded read of official status counts is accepted; missing counts
// or pagination metadata fail closed.
export const NONTERMINAL_NATIVE_STATUSES=Object.freeze([
 'queued','running','paused','waiting','waitingForPause','rollingBack'
]);
export function verifyNativeInstanceResponse(status,body){
 if(!NONTERMINAL_NATIVE_STATUSES.includes(status))fail('unsupported native status');
 const count=body?.result_info?.total_count;
 if(body?.success!==true||!Array.isArray(body?.result)||
    !Number.isSafeInteger(count)||count<0||
    !Number.isSafeInteger(body?.result_info?.count)||
    body.result_info.count!==body.result.length)fail('native inventory incomplete');
 if(count!==0||body.result.length!==0)fail('old native Workflow instances are still '+status);
 return true;
}
export async function checkNativeWorkflowDrain(account,headers,fetcher=fetch){
 for(const status of NONTERMINAL_NATIVE_STATUSES){
  const url=new URL('https://api.cloudflare.com/client/v4/accounts/'+account+
   '/workflows/workflow-mcp-orchestrator/instances');
  url.searchParams.set('status',status);
  url.searchParams.set('per_page','100');
  const res=await fetcher(url,{redirect:'manual',headers,signal:AbortSignal.timeout(15000)});
  if(!res.ok)fail('native status inventory request failed');
  verifyNativeInstanceResponse(status,await res.json());
 }
 return true;
}

async function main(){
 const account=process.env.CLOUDFLARE_ACCOUNT_ID,token=process.env.CLOUDFLARE_API_TOKEN;
 if(!/^[a-f0-9]{32}$/i.test(account??'')||!token)fail('read credential unavailable');
 const res=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/workflow-mcp-worker/settings`,{
  redirect:'manual',headers:{authorization:'Bearer '+token,accept:'application/json'},
  signal:AbortSignal.timeout(15000)});
 if(!res.ok)fail('runtime inventory request failed');
 const current=await res.json();
 if(current?.success!==true||!Array.isArray(current?.result?.bindings))
  fail('runtime inventory unavailable');
 const chunks=[];for await(const part of process.stdin)chunks.push(part);
 let parsed;try{parsed=JSON.parse(Buffer.concat(chunks).toString('utf8'));}
 catch{fail('D1 fence read malformed');}
 const check=verifyActionsCutoverReadback(current.result.bindings,parsed);
 if(check.transition==='legacy_to_unified'){
  requireOldIngressQuiescence(process.env.ACTIONS_OLD_INGRESS_QUIESCED);
  await checkNativeWorkflowDrain(account,{authorization:'Bearer '+token,accept:'application/json'});
  console.log('First Actions cutover: D1 fence and six native instance statuses verified; future admission still requires independent quiescence');
 }else{
  console.log('Existing unified Actions binding: D1 fence state verified; native-instance drain was not checked');
 }
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)
 main().catch(e=>{console.error(e.message);process.exitCode=1;});
