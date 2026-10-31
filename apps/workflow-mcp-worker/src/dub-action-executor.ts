import type {Env} from './store.ts';
import type {Plan,Step} from './plan.ts';
import {cloudflareActionManifest,canonical} from './cloudflare-action-contract.ts';
import {evaluateArguments} from './plan.ts';

type Result={status:'succeeded'|'failed'|'indeterminate';error_code?:string;output?:{status:string;short_link?:string}};
const failed=(error_code:string):Result=>({status:'failed',error_code});
const unknown=(error_code='dub_outcome_unknown'):Result=>({status:'indeterminate',error_code});
function checkedUrl(value:unknown):value is string{
 if(typeof value!=='string'||value.length>2048||value.length<10||/[\u0000-\u0020\u007f]/.test(value))return false;
 try{const u=new URL(value);return (u.protocol==='https:'||u.protocol==='http:')&&
  !!u.hostname&&!u.username&&!u.password&&!u.hash&&!u.port&&u.origin!=='null'&&(u.href===value||u.href===value+'/');}
 catch{return false;}
}
/** Only a manual Run's exact input URL, not a scheduled or chained arbitrary fetch.
 * D1 stores the Run input (including URL query) by the Owner's explicit choice.
 * The invocation fence stores only the digest; any lost response is unknown.
 */
export async function runDubAction(env:Env,plan:Plan,action:Step,runId:string,
 ctx?:{inputs:Record<string,unknown>;steps:Record<string,{status:string;output?:unknown}>}):Promise<Result>{
 const manifest=await cloudflareActionManifest('dub');
 const db=env.DB,provider=env.ACTIONS,version=env.ACTIONS_DEPLOYMENT_ID;
 if(plan.cloudflare_execution_approved!==true||plan.triggers?.length||
    action.uses!=='action.run'||action.with.executor!=='cloudflare'||
    action.with.provider!=='dub'||action.with.action!==manifest.action||
    action.with.contract_digest!==manifest.contract_digest)
  return failed('dub_manual_approval_required');
 const current=()=>db.prepare(`SELECT invocation_id,input_digest,contract_digest,deployment_id,
    binding_generation FROM cloudflare_action_invocations WHERE run_id=? AND step_id=?`)
    .bind(runId,action.id).first<{invocation_id:string;input_digest:string;
    contract_digest:string;deployment_id:string;binding_generation:number}>();
 try{
  const prior=await current();
  if(prior){
   const grant=plan.cloudflare_action_approvals?.some(g=>g.executor==='cloudflare'&&
     g.provider==='dub'&&g.action===manifest.action&&g.contract_digest===prior.contract_digest&&
     g.deployment_id===prior.deployment_id);
   return unknown(grant&&prior.binding_generation===0?'dub_receipt_unavailable':'cloudflare_invocation_conflict');
  }
  if(!provider||!version)return failed('cloudflare_provider_not_configured');
  if(!plan.cloudflare_action_approvals?.some(g=>g.executor==='cloudflare'&&g.provider==='dub'&&
      g.action===manifest.action&&g.contract_digest===manifest.contract_digest&&g.deployment_id===version))
   return failed('cloudflare_action_approval_required');
  let input:{url:string;public_stats:boolean};
  try{
   if(!ctx)throw Error('missing_ctx');
   const spec=action.with.input as Record<string,unknown>;
   if(!spec||typeof spec!=='object'||Array.isArray(spec)||
      !spec.url||typeof spec.url!=='object'||Array.isArray(spec.url)||
      Object.keys(spec.url).length!==1||(spec.url as {ref?:unknown}).ref!=='inputs.url'||
      Object.keys(spec).some(k=>!['url','public_stats'].includes(k)))throw Error('unapproved_source');
   const evaluated=evaluateArguments(spec.url,ctx);
   if(!checkedUrl(evaluated)||
      (spec.public_stats!==undefined&&typeof spec.public_stats!=='boolean'))throw Error('invalid_input');
   input={url:evaluated,public_stats:spec.public_stats===true};
  }catch{return failed('invalid_dub_url');}
  const raw=JSON.stringify(canonical(input));
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw));
  const input_digest=Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
  let live;
  try{live=await provider.getContract(manifest.action,manifest.contract_digest);}
  catch{return failed('cloudflare_provider_identity_unconfirmed');}
  if(live.contract_digest!==manifest.contract_digest||live.deployment_id!==version)
   return failed('cloudflare_provider_identity_mismatch');
  const invocation_id=crypto.randomUUID();
  const fence=await db.prepare(`INSERT OR IGNORE INTO cloudflare_action_invocations
    (run_id,step_id,invocation_id,source_attempt_id,input_digest,
     binding_generation,contract_digest,deployment_id,created_at)
    SELECT ?,?,?,?,?,0,?,?,? WHERE EXISTS(
      SELECT 1 FROM runs WHERE id=? AND outcome='running')
    AND EXISTS(SELECT 1 FROM cloudflare_action_gate WHERE id=1 AND state='open')
    AND NOT EXISTS(SELECT 1 FROM cloudflare_action_cancellations
      WHERE run_id=? AND step_id=?)`)
    .bind(runId,action.id,invocation_id,invocation_id,input_digest,
      manifest.contract_digest,version,Date.now(),runId,runId,action.id).run();
  if(fence.meta.changes!==1){return await current()?unknown('dub_receipt_unavailable'):failed('cloudflare_dispatch_not_admitted');}
  try{
   const result=await provider.execute(manifest.action,{...input,invocation_id,
    deployment_id:version,contract_digest:manifest.contract_digest,input_digest}) as
    {status:string;input_digest:string;short_link?:string};
   if(result.input_digest!==input_digest)return unknown('dub_digest_conflict');
   if(result.status==='accepted'&&typeof result.short_link==='string'&&
     /^https:\/\/dub\.sh\/[A-Za-z0-9_-]{3,64}$/.test(result.short_link))
    return {status:'succeeded',output:{status:'accepted',short_link:result.short_link}};
   if(result.status==='rejected')return failed('dub_rejected');
   return unknown();
  }catch{return unknown();}
 }catch{return unknown('cloudflare_dispatch_unconfirmed');}
}
