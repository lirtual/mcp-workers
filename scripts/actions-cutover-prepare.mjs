// Existing Workflow release workflow, pre-deploy-only 0018 admission fence.
// The old physical instance must be externally stopped before this script is run.
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {checkNativeWorkflowDrain,requireOldIngressQuiescence} from './actions-consumer-cutover-gate.mjs';
const db='a4a477cd-6339-478c-ab7c-f7d87bb0d772';
const fail=m=>{throw Error('Actions D1 preparation blocked: '+m);};
const uuid=/^[a-f0-9]{32}$/i;
export function verifyPausedInventory(rows){
 if(!Array.isArray(rows)||rows.length!==1)fail('Workflow inventory unavailable');
 const r=rows[0];
 if(!Number.isSafeInteger(r.active_workflows)||r.active_workflows!==0||
    !Number.isSafeInteger(r.paused_workflows)||r.paused_workflows<1||
    !Number.isSafeInteger(r.unsettled_runs)||r.unsettled_runs!==0)
   fail('published admission still active or durable Runs unsettled');
 return true;
}
export function verifyLegacyActionsBindings(bindings){
 if(!Array.isArray(bindings))fail('runtime bindings unavailable');
 const actual=bindings.filter(b=>b?.type==='service');
 const want=[['WEIXIN_ACTION_PROVIDER','weixin-mcp-worker','WeixinActionProvider'],
  ['BARK_ACTION_PROVIDER','bark-provider','BarkActionProvider']];
 for(const [name,service,entrypoint] of want){
  if(actual.filter(b=>b.name===name&&b.service===service&&b.entrypoint===entrypoint).length!==1)
   fail('original Service Binding topology changed');
 }
 if(actual.some(b=>b.name==='ACTIONS'))fail('unified binding already active');
 return true;
}
export async function readOnlyPrepare(env=process.env,request=fetch){
 requireOldIngressQuiescence(env.ACTIONS_OLD_INGRESS_QUIESCED);
 const account=env.CLOUDFLARE_ACCOUNT_ID,token=env.CLOUDFLARE_API_TOKEN;
 if(!uuid.test(account||'')||!token)fail('production credential unavailable');
 const headers={authorization:'Bearer '+token,accept:'application/json'};
 const get=async(path,body)=>{
  const result=await request('https://api.cloudflare.com/client/v4/accounts/'+account+path,
   {method:body?'POST':'GET',headers:{...headers,...(body?{'content-type':'application/json'}:{})},
    ...(body?{body:JSON.stringify(body)}:{}),redirect:'manual',signal:AbortSignal.timeout(15000)});
  if(!result.ok)fail('Cloudflare read-only API unavailable');
  const json=await result.json();if(json?.success!==true)fail('Cloudflare API rejected inventory');
  return json.result;
 };
 const settings=await get('/workers/scripts/workflow-mcp-worker/settings');
 verifyLegacyActionsBindings(settings?.bindings);
 const sql=`SELECT (SELECT COUNT(*) FROM workflows WHERE state='active' AND deleted_at IS NULL) AS active_workflows,
 (SELECT COUNT(*) FROM workflows WHERE state='paused' AND deleted_at IS NULL) AS paused_workflows,
 (SELECT COUNT(*) FROM runs WHERE outcome NOT IN ('succeeded','failed','cancelled','indeterminate')) AS unsettled_runs`;
 const snapshot=await get('/d1/database/'+db+'/query',{sql});
 if(!Array.isArray(snapshot)||snapshot.length!==1||snapshot[0]?.success!==true)
   fail('D1 inventory unavailable');
 verifyPausedInventory(snapshot[0]?.results);
 await checkNativeWorkflowDrain(account,headers,request);
 return true;
}
export function verifyFrozenGate(rows){
 if(!Array.isArray(rows)||rows.length!==1||rows[0]?.gate_state!=='frozen'||
  rows[0]?.migration_count!==1)fail('migration 0018 fence not frozen');
 return true;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const mode=process.argv[2];
 if(mode!=='preflight'&&mode!=='postflight')fail('unknown preparation mode');
 readOnlyPrepare().then(async()=>{
  if(mode==='postflight'){
   const account=process.env.CLOUDFLARE_ACCOUNT_ID,token=process.env.CLOUDFLARE_API_TOKEN;
   const sql="SELECT (SELECT state FROM cloudflare_action_gate WHERE id=1) AS gate_state, (SELECT COUNT(*) FROM d1_migrations WHERE name='0018_cloudflare_action_migration_fence.sql') AS migration_count";
   const response=await fetch('https://api.cloudflare.com/client/v4/accounts/'+account+'/d1/database/'+db+'/query',
    {method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},
    body:JSON.stringify({sql}),redirect:'manual',signal:AbortSignal.timeout(15000)});
   if(!response.ok)fail('fence readback request failed');
   const data=await response.json();if(data?.success!==true||data.result?.[0]?.success!==true)
    fail('fence readback rejected');
   verifyFrozenGate(data.result[0].results);
  }
  console.log('Workflow Actions preparation '+mode+' verified; no Worker deployed');
 }).catch(e=>{console.error(e.message);process.exitCode=1;});
}
