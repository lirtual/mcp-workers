import type {Env} from './store.ts';
import type {Plan,Step} from './plan.ts';
import {canonical,reviewedActionDeployment} from './cloudflare-action-contract.ts';
import {validateJsonActionInput} from './action-input-schema.ts';
import {evaluateArguments} from './plan.ts';

type Result={status:'succeeded'|'failed'|'indeterminate';error_code?:string;output?:{status:string;[key:string]:unknown}};
const failed=(error_code:string):Result=>({status:'failed',error_code});
const unknown=(error_code='cloudflare_outcome_unknown'):Result=>({status:'indeterminate',error_code});
/** One-shot normal JSON action. Never infer success from a lost Provider ACK. */
export async function runGenericJsonAction(env:Env,plan:Plan,step:Step,runId:string,
 ctx?:{inputs:Record<string,unknown>;steps:Record<string,{status:string;output?:unknown}>}):Promise<Result>{
 const manifest=plan.cloudflare_action_contracts?.[step.id];
 if(!manifest||manifest.source_repository!=='lirtual/cloudflare-actions'||
   manifest.executor!=='cloudflare'||!['none','read_only'].includes(String(manifest.side_effect))||
   manifest.action!==step.with.action||manifest.provider!==step.with.provider||
   manifest.contract_digest!==step.with.contract_digest||
   plan.cloudflare_execution_approved!==true)return failed('cloudflare_action_not_reviewed');
 const grant=plan.cloudflare_action_approvals?.some(g=>g.executor==='cloudflare'&&
   g.action===step.with.action&&g.provider===step.with.provider&&
   g.contract_digest===step.with.contract_digest);
 if(!grant)return failed('cloudflare_action_approval_required');
 let input:Record<string,unknown>;
 try{input=(ctx?evaluateArguments(step.with.input,ctx):step.with.input) as Record<string,unknown>;
   validateJsonActionInput(manifest.input_schema,input);}
 catch{return failed('invalid_json_action_input');}
 const provider=env.ACTIONS;if(!provider)return failed('cloudflare_provider_not_configured');
 const db=env.DB;
 const current=()=>db.prepare('SELECT invocation_id FROM cloudflare_action_invocations WHERE run_id=? AND step_id=?')
   .bind(runId,step.id).first<{invocation_id:string}>();
 try{
   if(await current())return unknown('cloudflare_receipt_unavailable');
   const contracted=await provider.getContract(String(step.with.action),String(step.with.contract_digest));
   const deployment=reviewedActionDeployment(contracted,String(step.with.contract_digest));
   if(!deployment)return failed('cloudflare_provider_identity_mismatch');
   const input_digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
     new TextEncoder().encode(JSON.stringify(canonical(input))))),b=>b.toString(16).padStart(2,'0')).join('');
   const invocation_id=crypto.randomUUID();
   const fence=await db.prepare(`INSERT OR IGNORE INTO cloudflare_action_invocations
    (run_id,step_id,invocation_id,source_attempt_id,input_digest,binding_generation,
     contract_digest,deployment_id,created_at)
    SELECT ?,?,?,?,?,0,?,?,? WHERE EXISTS(SELECT 1 FROM runs WHERE id=? AND outcome='running')
     AND EXISTS(SELECT 1 FROM cloudflare_action_gate WHERE id=1 AND state='open')
     AND NOT EXISTS(SELECT 1 FROM cloudflare_action_cancellations WHERE run_id=? AND step_id=?)`)
     .bind(runId,step.id,invocation_id,invocation_id,input_digest,
       step.with.contract_digest,deployment,Date.now(),runId,runId,step.id).run();
   if(fence.meta.changes!==1)return await current()?unknown('cloudflare_receipt_unavailable'):
     failed('cloudflare_dispatch_not_admitted');
   try{
     const output=await provider.execute(String(step.with.action),{...input,invocation_id,
       deployment_id:deployment,contract_digest:step.with.contract_digest,input_digest});
     if(output.input_digest!==input_digest)return unknown('cloudflare_digest_conflict');
     if(output.status==='accepted'){
       const schema=manifest.output_schema;
       if(schema===undefined)return {status:'succeeded',output:{status:'accepted'}};
       if(!schema||typeof schema!=='object'||Array.isArray(schema)||
          !('properties' in schema)||!schema.properties||typeof schema.properties!=='object')
          return unknown('cloudflare_output_unreviewed');
       const props=schema.properties as Record<string,unknown>,allowed=new Set(Object.keys(props));
       const metadata=new Set(['input_digest','deployment_id','invocation_id']);
       if(Object.keys(output).some(k=>!allowed.has(k)&&!metadata.has(k)))
         return unknown('cloudflare_output_unreviewed');
       const projected=Object.fromEntries(Object.entries(output).filter(([k])=>allowed.has(k)));
       try{validateJsonActionInput(schema,projected);}
       catch{return unknown('cloudflare_output_unreviewed');}
       return {status:'succeeded',output:projected as {status:string}};
     }
     if(output.status==='rejected')return failed('cloudflare_provider_rejected');
     return unknown();
   }catch{return unknown();}
 }catch{return unknown('cloudflare_dispatch_unconfirmed');}
}
