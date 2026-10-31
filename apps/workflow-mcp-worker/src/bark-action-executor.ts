import type {Env} from './store.ts';
import type {Plan,Step} from './plan.ts';
import {canonical,cloudflareActionManifest} from './cloudflare-action-contract.ts';
import {evaluateArguments} from './plan.ts';

/** Stateless Bark: the existing D1 reservation is the only send admission.
 * A prior reservation can never trigger another RPC; without receipts it is unknown.
 */
type Result={status:'succeeded'|'failed'|'indeterminate';error_code?:string;output?:{status:string}};
const deny=(error_code:string):Result=>({status:'failed',error_code});
const unknown=(error_code='bark_outcome_unknown'):Result=>({status:'indeterminate',error_code});
function normalize(value:unknown){
 if(typeof value==='string')return value;
 if(value===null||typeof value!=='object')throw Error('invalid_bark_content');
 return JSON.stringify(canonical(value));
}
export async function runBarkAction(env:Env,plan:Plan,action:Step,runId:string,
 ctx?:{inputs:Record<string,unknown>;steps:Record<string,{status:string;output?:unknown}>}):Promise<Result>{
 const provider=env.ACTIONS,version=env.ACTIONS_DEPLOYMENT_ID;
 const manifest=await cloudflareActionManifest('bark');
 const grant=plan.cloudflare_action_approvals?.find(g=>g.executor==='cloudflare'&&
  g.provider==='bark'&&g.action===manifest.action&&
  g.contract_digest===manifest.contract_digest);
 if(plan.cloudflare_execution_approved!==true||action.uses!=='action.run'||
  action.with.executor!=='cloudflare'||action.with.provider!=='bark'||
  action.with.action!==manifest.action)return deny('cloudflare_action_approval_required');
 const db=env.DB;
 const existing=()=>db.prepare(`SELECT invocation_id,source_attempt_id,input_digest,
    binding_generation,contract_digest,deployment_id
    FROM cloudflare_action_invocations WHERE run_id=? AND step_id=?`)
    .bind(runId,action.id).first<{invocation_id:string;source_attempt_id:string;
      binding_generation:number;input_digest:string;contract_digest:string;deployment_id:string}>();
 try{
  const prior=await existing();
  if(prior){
   // Historical identity comes from immutable original grant, never current deployment.
   const approved=plan.cloudflare_action_approvals?.some(g=>g.executor==='cloudflare'&&
     g.provider==='bark'&&g.action==='bark.send_notification'&&
     g.contract_digest===prior.contract_digest&&g.deployment_id===prior.deployment_id);
   return unknown(approved&&prior.binding_generation===0?'bark_receipt_unavailable':'cloudflare_invocation_conflict');
  }
  if(!grant||action.with.contract_digest!==manifest.contract_digest)
   return deny('cloudflare_action_approval_required');
  if(!provider||!version)return deny('cloudflare_provider_not_configured');
  if(grant.deployment_id!==version)return deny('cloudflare_provider_version_changed');
  let notification:Record<string,unknown>;
  try{
   if(!ctx)throw Error('missing_context');
   const source=(action.with.input as {notification?:unknown}|undefined)?.notification;
   const evaluated=evaluateArguments(source,ctx) as unknown;
   if(!evaluated||typeof evaluated!=='object'||Array.isArray(evaluated))
    throw Error('invalid_bark_notification');
   const values=evaluated as Record<string,unknown>;
   if(typeof values.body!=='string')values.body=normalize(values.body);
   if(Object.keys(values).some(k=>!Object.hasOwn(manifest.input_schema.properties,k)))
    throw Error('invalid_bark_notification');
   // Pre-dispatch cap; Provider repeats strict field and transport validation.
   if(new TextEncoder().encode(JSON.stringify(values)).byteLength>2900)
    throw Error('invalid_bark_notification');
   notification=values;
  }catch{return deny('invalid_bark_notification');}
  let bound;
  try{bound=await provider.getContract(manifest.action);}catch{return deny('cloudflare_provider_identity_unconfirmed');}
  if(bound.deployment_id!==version||bound.contract_digest!==manifest.contract_digest)
   return deny('cloudflare_provider_identity_mismatch');
  const payload=JSON.stringify(canonical(notification));
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(payload));
  const inputDigest=Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
  const id=crypto.randomUUID();
  // Reuse existing persisted fence; non-Weixin rows use generation=0 and
  // source_attempt_id=invocation_id as a non-sensitive sentinel.
  const fence=await db.prepare(`INSERT OR IGNORE INTO cloudflare_action_invocations
    (run_id,step_id,invocation_id,source_attempt_id,input_digest,
     binding_generation,contract_digest,deployment_id,created_at)
    SELECT ?,?,?,?,?,0,?,?,? WHERE EXISTS(
      SELECT 1 FROM runs WHERE id=? AND outcome='running')
    AND EXISTS(SELECT 1 FROM cloudflare_action_gate WHERE id=1 AND state='open')
    AND NOT EXISTS(SELECT 1 FROM cloudflare_action_cancellations c
      WHERE c.run_id=? AND c.step_id=?)`)
    .bind(runId,action.id,id,id,inputDigest,manifest.contract_digest,version,
      Date.now(),runId,runId,action.id).run();
  if(fence.meta.changes!==1){
   return await existing()?unknown('bark_receipt_unavailable'):deny('cloudflare_dispatch_not_admitted');
  }
  try{
   const result=await provider.execute(manifest.action,{invocation_id:id,
    deployment_id:version,contract_digest:manifest.contract_digest,
    input_digest:inputDigest,notification});
   if(result.input_digest!==inputDigest)return unknown('bark_digest_conflict');
   if(result.status==='accepted')return {status:'succeeded',output:{status:'accepted'}};
   if(result.status==='rejected')return deny('bark_rejected');
   return unknown();
  }catch{return unknown();}
 }catch{return unknown('cloudflare_dispatch_unconfirmed');}
}
