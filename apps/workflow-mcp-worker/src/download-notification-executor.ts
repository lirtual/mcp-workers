import type {Env} from './store.ts';
import type {Plan,Step} from './plan.ts';
import {cloudflareActionManifest} from './cloudflare-action-contract.ts';

// Must exactly match the Provider-owned immutable message. No caller-supplied text or URL.
export const DOWNLOAD_COMPLETED_TEXT='Koofr 下载完成，云端文件回读校验已通过。';
const digest=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest(
 'SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
type Result={status:'succeeded'|'failed'|'indeterminate';error_code?:string;output?:{status:string}};
type Frozen={invocation_id:string;source_attempt_id:string;input_digest:string;
 binding_generation:number;contract_digest:string;deployment_id:string};
const failed=(error_code:string):Result=>({status:'failed',error_code});
const unknown=(error_code='cloudflare_outcome_unknown'):Result=>({status:'indeterminate',error_code});
const receipt=(value:unknown):Result=>value==='accepted'
 ?{status:'succeeded',output:{status:'accepted'}}
 :value==='rejected'?failed('weixin_rejected'):unknown();

/** Do not infer a verified transfer from the caller's response or a user-supplied status.
 * A completed GitHub Task must have a signed OIDC Claim and persisted
 * physical terminal success; the reviewed download.yml only exits zero after
 * aria2, rclone upload and remote SHA-256 readback complete.
 */
export async function runDownloadNotification(
 env:Env,plan:Plan,action:Step,runId:string,
 ctx?:{inputs:Record<string,unknown>;steps:Record<string,{status:string;output?:unknown}>},
):Promise<Result>{
 const manifest=await cloudflareActionManifest('download');
 const provider=env.WEIXIN_ACTION_PROVIDER,version=env.WEIXIN_ACTION_DEPLOYMENT_ID;
 const grant=plan.cloudflare_action_approvals?.find(x=>x.executor==='cloudflare'&&
  x.provider===manifest.provider&&x.action===manifest.action&&
  x.contract_digest===manifest.contract_digest&&x.deployment_id===version);
 if(!provider||!version)return failed('cloudflare_provider_not_configured');
 if(plan.cloudflare_execution_approved!==true||!grant||action.with.executor!=='cloudflare'||
  action.with.provider!=='weixin'||action.with.action!==manifest.action||action.with.contract_digest!==manifest.contract_digest)
  return failed('cloudflare_action_approval_required');
 const sourceId=(action.with.input as {download_step_id?:unknown}|undefined)?.download_step_id;
 const source=plan.steps.find(x=>x.id===sourceId);
 const template=source?.with.template as {id?:unknown;uses?:unknown;with?:{action?:unknown}}|undefined;
 const pinned=template?.with?.action as {repository?:unknown;workflowPath?:unknown;type?:unknown}|undefined;
 if(typeof sourceId!=='string'||!action.needs.includes(sourceId)||
  ctx?.steps[sourceId]?.status!=='succeeded'||
  source?.uses!=='flow.foreach'||source.with.max_items!==1||
  template?.uses!=='github.run'||typeof template.id!=='string'||
  pinned?.repository!=='lirtual/session-actions'||
  pinned.workflowPath!=='.github/workflows/download.yml'||pinned.type!=='task')
  return failed('untrusted_download_reference');
 const childId=sourceId+'_0_'+template.id;
 const db=env.DB;
 const existing=()=>db.prepare(`SELECT invocation_id,source_attempt_id,input_digest,
  binding_generation,contract_digest,deployment_id
  FROM cloudflare_action_invocations WHERE run_id=? AND step_id=?`)
  .bind(runId,action.id).first<Frozen>();
 const history=async(row:Frozen):Promise<Result>=>{
  try{
   const response=await provider.getReceipt({invocation_id:row.invocation_id,
    binding_generation:row.binding_generation,input_digest:row.input_digest});
   return receipt(response.status);
  }catch{return unknown('cloudflare_receipt_unconfirmed');}
 };
 try{
  const prior=await existing();
  if(prior){
   if(prior.contract_digest!==manifest.contract_digest||prior.deployment_id!==version||
    prior.input_digest!==await digest(DOWNLOAD_COMPLETED_TEXT)||
    !Number.isSafeInteger(prior.binding_generation)||prior.binding_generation<1)
    return unknown('cloudflare_invocation_conflict');
   return history(prior);
  }
  let live;
  try{live=await provider.getDownloadContract();}
  catch{return failed('cloudflare_provider_identity_unconfirmed');}
  if(live.deployment_id!==version||live.contract_digest!==manifest.contract_digest)
   return failed('cloudflare_provider_identity_mismatch');
  // Task reconciliation has already validated GitHub's physical terminal
  // against the signed OIDC Claim before setting a.state='succeeded'.
  const proof=await db.prepare(`SELECT a.attempt_id FROM step_attempts a
    JOIN run_steps child ON child.run_id=a.run_id AND child.step_id=a.step_id
    JOIN run_steps parent ON parent.run_id=a.run_id AND parent.step_id=?
   WHERE a.run_id=? AND a.step_id=? AND a.capability_id='github.action'
    AND a.state='succeeded' AND child.status='succeeded'
    AND parent.status='succeeded'
    AND a.repository='lirtual/session-actions'
    AND a.workflow_ref LIKE 'lirtual/session-actions/.github/workflows/download.yml@%'
    AND a.owner_run_id=a.candidate_run_id
    AND a.owner_run_attempt=a.candidate_run_attempt`)
   .bind(sourceId,runId,childId).first<{attempt_id:string}>();
  if(!proof)return failed('download_completion_unverified');
  let binding;
  try{binding=await provider.getBinding();}
  catch{return failed('weixin_binding_unconfirmed');}
  if(!binding?.ready||!Number.isSafeInteger(binding.generation)||binding.generation<1)
   return failed('weixin_binding_not_ready');
  const inputDigest=await digest(DOWNLOAD_COMPLETED_TEXT);
  const identity=crypto.randomUUID();
  const admitted=await db.prepare(`INSERT OR IGNORE INTO cloudflare_action_invocations
   (run_id,step_id,invocation_id,source_attempt_id,input_digest,binding_generation,
    contract_digest,deployment_id,created_at)
   SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(
    SELECT 1 FROM runs WHERE id=? AND outcome='running')
   AND EXISTS(SELECT 1 FROM step_attempts a JOIN run_steps child
      ON child.run_id=a.run_id AND child.step_id=a.step_id
     JOIN run_steps parent ON parent.run_id=a.run_id AND parent.step_id=?
      WHERE a.run_id=? AND a.step_id=? AND a.attempt_id=?
      AND a.capability_id='github.action' AND a.state='succeeded'
      AND child.status='succeeded' AND parent.status='succeeded'
      AND a.repository='lirtual/session-actions'
      AND a.workflow_ref LIKE 'lirtual/session-actions/.github/workflows/download.yml@%'
      AND a.owner_run_id=a.candidate_run_id
      AND a.owner_run_attempt=a.candidate_run_attempt)
   AND NOT EXISTS(SELECT 1 FROM cloudflare_action_cancellations c
       WHERE c.run_id=? AND c.step_id=?)`)
   .bind(runId,action.id,identity,proof.attempt_id,inputDigest,binding.generation,
    manifest.contract_digest,version,Date.now(),runId,sourceId,runId,childId,
    proof.attempt_id,runId,action.id).run();
  if(admitted.meta.changes!==1){
   const raced=await existing();
   return raced?history(raced):failed('cloudflare_dispatch_not_admitted');
  }
  try{
   const response=await provider.sendDownloadComplete({invocation_id:identity,
    binding_generation:binding.generation,deployment_id:version,
    contract_digest:manifest.contract_digest});
   if(response.input_digest!==inputDigest)return unknown('weixin_receipt_conflict');
   return receipt(response.status);
  }catch{return history({invocation_id:identity,source_attempt_id:proof.attempt_id,
    input_digest:inputDigest,binding_generation:binding.generation,
    contract_digest:manifest.contract_digest,deployment_id:version});}
 }catch{return unknown('cloudflare_dispatch_unconfirmed');}
}
