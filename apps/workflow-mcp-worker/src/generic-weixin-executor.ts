import type {Env} from './store.ts';
import type {Plan,Step} from './plan.ts';
import {cloudflareActionManifest} from './cloudflare-action-contract.ts';

type Result={status:'succeeded'|'failed'|'indeterminate';error_code?:string;output?:{status:string}};
type Frozen={invocation_id:string;source_attempt_id:string;input_digest:string;
 binding_generation:number;contract_digest:string;deployment_id:string};
const fail=(error_code:string):Result=>({status:'failed',error_code});
const unknown=(error_code='cloudflare_outcome_unknown'):Result=>({status:'indeterminate',error_code});
const outcome=(status:unknown):Result=>status==='accepted'
 ?{status:'succeeded',output:{status:'accepted'}}:
 status==='rejected'?fail('weixin_rejected'):unknown();
const digest=async(text:string)=>Array.from(new Uint8Array(await crypto.subtle.digest(
 'SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');

/** Fixed user-approved text, with no guessed task success and no automatic resend. */
export async function runGenericTextNotification(
 env:Env,plan:Plan,action:Step,runId:string,
 ctx?:{inputs:Record<string,unknown>;steps:Record<string,{status:string;output?:unknown}>},
):Promise<Result>{
 const legacy=await cloudflareActionManifest('generic');
 const unified=await cloudflareActionManifest('unified-generic');
 const isUnified=action.with.contract_digest===unified.contract_digest;
 const manifest=isUnified?unified:legacy;
 const provider=isUnified?env.ACTIONS:env.WEIXIN_ACTION_PROVIDER;
 const version=isUnified?env.ACTIONS_DEPLOYMENT_ID:env.WEIXIN_ACTION_DEPLOYMENT_ID;
 if(plan.cloudflare_execution_approved!==true||action.with.action!==manifest.action||
    action.with.executor!=='cloudflare'||action.with.provider!=='weixin'||
    action.with.contract_digest!==manifest.contract_digest)return fail('cloudflare_action_approval_required');
 if(action.needs.some(id=>ctx?.steps[id]?.status!=='succeeded'))
   return fail('notification_dependency_unverified');
 const text=(action.with.input as {text?:unknown}|undefined)?.text;
 if(typeof text!=='string'||!text.trim()||text.length>2048||
    new TextEncoder().encode(text).byteLength>4096)
   return fail('invalid_weixin_text');
 const inputDigest=await digest(text),db=env.DB;
 const existing=()=>db.prepare(`SELECT invocation_id,source_attempt_id,input_digest,
   binding_generation,contract_digest,deployment_id
   FROM cloudflare_action_invocations WHERE run_id=? AND step_id=?`)
   .bind(runId,action.id).first<Frozen>();
 const recover=async(row:Frozen):Promise<Result>=>{
   const original=plan.cloudflare_action_approvals?.some(g=>g.executor==='cloudflare'&&
     g.provider==='weixin'&&g.action===manifest.action&&
     g.contract_digest===row.contract_digest&&g.deployment_id===row.deployment_id);
   if(!original||row.input_digest!==inputDigest||row.contract_digest!==manifest.contract_digest||
      !Number.isSafeInteger(row.binding_generation)||row.binding_generation<1)
     return unknown('cloudflare_invocation_conflict');
   try{
     const query={invocation_id:row.invocation_id,binding_generation:row.binding_generation,
       input_digest:row.input_digest};
     const value=env.ACTIONS?await env.ACTIONS.getReceipt(manifest.action,query):
       await env.WEIXIN_ACTION_PROVIDER!.getReceipt(query);
     return outcome(value.status);
   }catch{return unknown('cloudflare_receipt_unconfirmed');}
 };
 try{
   const prior=await existing();if(prior)return recover(prior);
   if(!provider||!version)return fail('cloudflare_provider_not_configured');
  if(!plan.cloudflare_action_approvals?.some(g=>g.executor==='cloudflare'&&
      g.provider==='weixin'&&g.action===manifest.action&&
      g.contract_digest===manifest.contract_digest&&g.deployment_id===version))
    return fail('cloudflare_action_approval_required');

   // Only the orchestrator's persisted terminal states authorize a first send;
   // the caller-supplied in-memory context cannot fabricate a completed Task.
   if(action.needs.length){
     const dependencies=await db.prepare(`SELECT COUNT(*) AS n FROM run_steps
       WHERE run_id=? AND status='succeeded' AND step_id IN (${action.needs.map(()=>'?').join(',')})`)
       .bind(runId,...action.needs).first<{n:number}>();
     if(dependencies?.n!==action.needs.length)
       return fail('notification_dependency_unverified');
   }
   let identity;
   try{identity=isUnified?await env.ACTIONS!.getContract(manifest.action,manifest.contract_digest):
      await env.WEIXIN_ACTION_PROVIDER!.getGenericContract();}
   catch{return fail('cloudflare_provider_identity_unconfirmed');}
   if(identity.deployment_id!==version||identity.contract_digest!==manifest.contract_digest)
     return fail('cloudflare_provider_identity_mismatch');
   let binding;
   try{binding=isUnified?await env.ACTIONS!.getBinding(manifest.action):
      await env.WEIXIN_ACTION_PROVIDER!.getBinding();}
   catch{return fail('weixin_binding_unconfirmed');}
   if(!binding.ready||!Number.isSafeInteger(binding.generation)||binding.generation<1)
     return fail('weixin_binding_not_ready');
   const invocationId=crypto.randomUUID();
   // For literal-only messages no external Attempt exists; use this invocation as source identity.
   const admitted=await db.prepare(`INSERT OR IGNORE INTO cloudflare_action_invocations
    (run_id,step_id,invocation_id,source_attempt_id,input_digest,binding_generation,
     contract_digest,deployment_id,created_at)
    SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(
      SELECT 1 FROM runs WHERE id=? AND outcome='running')
    AND (?=0 OR EXISTS(SELECT 1 FROM cloudflare_action_gate WHERE id=1 AND state='open'))
    AND NOT EXISTS(SELECT 1 FROM cloudflare_action_cancellations
      WHERE run_id=? AND step_id=?)`)
    .bind(runId,action.id,invocationId,invocationId,inputDigest,binding.generation,
      manifest.contract_digest,version,Date.now(),runId,isUnified?1:0,runId,action.id).run();
   if(admitted.meta.changes!==1){const raced=await existing();
     return raced?recover(raced):fail('cloudflare_dispatch_not_admitted');}
   try{
     const input={invocation_id:invocationId,binding_generation:binding.generation,
       text,deployment_id:version,contract_digest:manifest.contract_digest};
     const result=isUnified?await env.ACTIONS!.execute(manifest.action,input):
       await env.WEIXIN_ACTION_PROVIDER!.sendGenericText(input);
     return result.input_digest===inputDigest?outcome(result.status):unknown('weixin_receipt_conflict');
   }catch{return recover({invocation_id:invocationId,source_attempt_id:invocationId,
     input_digest:inputDigest,binding_generation:binding.generation,
     contract_digest:manifest.contract_digest,deployment_id:version});}
 }catch{return unknown('cloudflare_dispatch_unconfirmed');}
}
