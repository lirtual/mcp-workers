import type {Env} from './store.ts';
import type {Plan,Step} from './plan.ts';
import {cloudflareActionManifest,canonical} from './cloudflare-action-contract.ts';
import {evaluateArguments} from './plan.ts';
import {checkedSharePayload,fromBase58,type SharePayload} from './envshare-secret.ts';

type Result={status:'succeeded'|'failed'|'indeterminate';error_code?:string;
 output?:{status:'accepted';share_id:string}};
const failed=(error_code:string):Result=>({status:'failed',error_code});
const unknown=(error_code='envshare_outcome_unknown'):Result=>({status:'indeterminate',error_code});

/** The encryption key is deliberately absent: D1 stores only ciphertext/IV. */
export async function runEnvshareAction(env:Env,plan:Plan,action:Step,runId:string,
 ctx?:{inputs:Record<string,unknown>;steps:Record<string,{status:string;output?:unknown}>}):Promise<Result>{
 const manifest=await cloudflareActionManifest('envshare');
 const db=env.DB,provider=env.ACTIONS,version=env.ACTIONS_DEPLOYMENT_ID;
 if(plan.cloudflare_execution_approved!==true||plan.triggers?.length||
    plan.steps.length!==1||action.uses!=='action.run'||
    action.with.executor!=='cloudflare'||action.with.provider!=='envshare'||
    action.with.action!==manifest.action||action.with.contract_digest!==manifest.contract_digest)
  return failed('envshare_manual_approval_required');
 const current=()=>db.prepare(`SELECT invocation_id,input_digest,contract_digest,deployment_id,
    binding_generation FROM cloudflare_action_invocations WHERE run_id=? AND step_id=?`)
    .bind(runId,action.id).first<{invocation_id:string;input_digest:string;
    contract_digest:string;deployment_id:string;binding_generation:number}>();
 try{
  const prior=await current();
  if(prior)return unknown('envshare_receipt_unavailable'); // No repeat/secret recovery.
  if(!provider||!version)return failed('cloudflare_provider_not_configured');
  if(!plan.cloudflare_action_approvals?.some(g=>g.executor==='cloudflare'&&
       g.provider==='envshare'&&g.action===manifest.action&&
       g.contract_digest===manifest.contract_digest&&g.deployment_id===version))
    return failed('cloudflare_action_approval_required');
  let input:SharePayload;
  try{
   if(!ctx)throw Error('missing_context');
   const spec=action.with.input as Record<string,unknown>;
   if(!spec||typeof spec!=='object'||Array.isArray(spec)||
     Object.keys(spec).sort().join(',')!=='encrypted,iv,reads,ttl')throw Error('unsupported_input');
   for(const name of ['encrypted','iv']){
    const field=spec[name];
    if(!field||typeof field!=='object'||Array.isArray(field)||
      Object.keys(field).length!==1||(field as {ref?:unknown}).ref!=='inputs.'+name)
     throw Error('unsupported_source');
   }
   const checked={encrypted:evaluateArguments(spec.encrypted,ctx),
    iv:evaluateArguments(spec.iv,ctx),ttl:spec.ttl,reads:spec.reads};
   if(!checkedSharePayload(checked)||ctx.inputs.ttl!==checked.ttl||
      ctx.inputs.reads!==checked.reads)throw Error('invalid_ciphertext');
   input=checked;
  }catch{return failed('envshare_invalid_ciphertext');}
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(canonical(input))));
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
  if(fence.meta.changes!==1)
   return await current()?unknown('envshare_receipt_unavailable'):failed('cloudflare_dispatch_not_admitted');
  try{
   const result=await provider.execute(manifest.action,{...input,invocation_id,
    deployment_id:version,contract_digest:manifest.contract_digest,input_digest}) as
    {status:string;input_digest:string;share_id?:string};
   if(result.input_digest!==input_digest)return unknown('envshare_digest_conflict');
   const id=typeof result.share_id==='string'?fromBase58(result.share_id,32):null;
   if(result.status==='accepted'&&id?.length===16)
    return {status:'succeeded',output:{status:'accepted',share_id:result.share_id!}};
   if(result.status==='rejected')return failed('envshare_rejected');
   return unknown();
  }catch{return unknown();}
 }catch{return unknown('cloudflare_dispatch_unconfirmed');}
}
