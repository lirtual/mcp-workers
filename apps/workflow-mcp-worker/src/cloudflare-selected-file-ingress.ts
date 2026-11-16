/** The existing Cloudflare Service Binding is the bounded memory-bytes file
 * adapter. It is admitted only by a source-reviewed Published Action. No
 * selected bytes, file locator or external side effect enter durable Run input.
 */
import {WorkflowService,StateError,type Env} from './store.ts';
import {readBoundedAttachment,approvedAttachmentUrl,type ChatGptFile} from './litterbox-file-source.ts';
import {reviewedActionDeployment,canonical} from './cloudflare-action-contract.ts';
import {validateJsonActionInput} from './action-input-schema.ts';
import {cloudflareSelectedFilePlan,type CloudflareFilePlan} from './cloudflare-selected-file.ts';
import type {Plan} from './plan.ts';

type Outcome={status:'succeeded'|'failed'|'indeterminate';error_code?:string;output?:Record<string,unknown>};
const FILENAME=/^[^\/\\\u0000-\u001f\u007f]{1,160}$/u;
async function digest(o:unknown){
 const hash=await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(JSON.stringify(canonical(o))));
 return Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
}
const object=(x:unknown):x is Record<string,unknown>=>
 x!==null&&typeof x==='object'&&!Array.isArray(x);
function reviewedResponse(raw:unknown,manifest:Record<string,unknown>):Outcome{
 if(!object(raw)||!object(manifest.output_schema))return {
  status:'indeterminate',error_code:'selected_file_receipt_invalid'};
 const allowed=Object.keys((manifest.output_schema as Record<string,unknown>).properties as object);
 const metadata=['input_digest','deployment_id','invocation_id'];
 if(Object.keys(raw).some(k=>!allowed.includes(k)&&!metadata.includes(k)))
  return {status:'indeterminate',error_code:'selected_file_receipt_invalid'};
 const output=Object.fromEntries(Object.entries(raw).filter(([k])=>allowed.includes(k)));
 if(output.status!=='accepted'||JSON.stringify(output).length>4096)
  return {status:'indeterminate',error_code:'selected_file_receipt_invalid'};
 try{validateJsonActionInput(manifest.output_schema,output);}
 catch{return {status:'indeterminate',error_code:'selected_file_receipt_invalid'};}
 return {status:'succeeded',output};
}
export async function recordedCloudflareFileStep(
 db:D1Database,plan:Plan,runId:string,stepId:string,
):Promise<Outcome|null>{
 const reviewed=cloudflareSelectedFilePlan(plan);
 if(!reviewed||reviewed.step_id!==stepId)return null;
 const row=await db.prepare(`SELECT s.status,s.output,s.error_code FROM run_steps s
  JOIN cloudflare_action_invocations a ON a.run_id=s.run_id AND a.step_id=s.step_id
  WHERE s.run_id=? AND s.step_id=?`).bind(runId,stepId)
  .first<{status:string;output:string|null;error_code:string|null}>();
 if(!row||!['succeeded','failed','indeterminate'].includes(row.status))return null;
 if(row.status!=='succeeded')
  return {status:row.status as 'failed'|'indeterminate',error_code:row.error_code??undefined};
 let output:unknown;
 try{output=JSON.parse(row.output??'');}
 catch{return {status:'indeterminate',error_code:'selected_file_receipt_invalid'};}
 return reviewedResponse(output,reviewed.manifest);
}
export async function startCloudflareSelectedFile(env:Env,args:{
 workflow_id:string;file:ChatGptFile;inputs:Record<string,unknown>;
 idempotency_key:string;expected_published_version_id?:string;
},capability:CloudflareFilePlan,version:string){
 if(Object.keys(args.inputs).length!==1||args.inputs.public_file_upload_accepted!==true)
  throw new StateError('selected_file_public_upload_consent_required');
 if(!/^[A-Za-z0-9_-]{1,128}$/.test(args.idempotency_key))
  throw new StateError('file_idempotency_key_required');
 if(!approvedAttachmentUrl(args.file))throw new StateError('selected_file_source_unverified');
 const name=args.file.file_name;
 if(!name||!FILENAME.test(name)||name==='.'||name==='..'||
    name.startsWith('.')||name.trim()!==name||
    (!capability.policy.extensions.includes('*')&&
      !capability.policy.extensions.some(ext=>name.toLowerCase().endsWith(ext))))
  throw new StateError('selected_file_type_rejected');
 // A D1 Published Plan may only use its original source-reviewed digest.
 const {contract_digest,...source}=capability.manifest;
 if(await digest(source)!==contract_digest)
  throw new StateError('selected_file_contract_changed');
 if(!env.ACTIONS)throw new StateError('cloudflare_provider_not_configured');
 let identity;
 try{identity=await env.ACTIONS.getContract(String(capability.manifest.action),
  String(capability.manifest.contract_digest));}
 catch{throw new StateError('cloudflare_provider_identity_unconfirmed');}
 const deployment=reviewedActionDeployment(identity,String(capability.manifest.contract_digest));
 if(!deployment)throw new StateError('cloudflare_provider_identity_mismatch');
 // One bounded GET before the first Run reservation; no redirect or origin expansion.
 const selected=await readBoundedAttachment(args.file);
 if(selected.size_bytes>capability.policy.max_bytes)
  throw new StateError('selected_file_size_limit');
 const meta={file_name:name,size_bytes:selected.size_bytes,
  sha256:selected.sha256,time:'24h'};
 try{validateJsonActionInput(capability.manifest.input_schema,meta);}
 catch{throw new StateError('selected_file_metadata_invalid');}
 const run=await new WorkflowService(env).start(args.workflow_id,meta,args.idempotency_key,
  undefined,'cloudflare_selected_file',version);
 if(run.start_state!=='started')
  return {run_id:run.run_id,status:'indeterminate' as const,error_code:'selected_file_start_unknown'};
 const invocation_id=crypto.randomUUID(),input_digest=await digest(meta);
 const saved=await env.DB.prepare(`INSERT OR IGNORE INTO cloudflare_action_invocations
  (run_id,step_id,invocation_id,source_attempt_id,input_digest,binding_generation,
   contract_digest,deployment_id,created_at)
  SELECT ?,?,?,?, ?,0,?,?,? WHERE EXISTS(
   SELECT 1 FROM runs r JOIN workflows w ON w.id=r.workflow_id
   WHERE r.id=? AND r.version_id=? AND r.outcome IN ('queued','running')
    AND w.active_version_id=? AND w.state='active' AND w.deleted_at IS NULL)
  AND EXISTS(SELECT 1 FROM cloudflare_action_gate WHERE id=1 AND state='open')
  AND NOT EXISTS(SELECT 1 FROM cloudflare_action_cancellations WHERE run_id=? AND step_id=?)`)
  .bind(run.run_id,capability.step_id,invocation_id,invocation_id,input_digest,
   capability.manifest.contract_digest,deployment,Date.now(),
   run.run_id,version,version,run.run_id,capability.step_id).run();
 if(saved.meta.changes!==1)throw new StateError('selected_file_dispatch_not_admitted');
 let result:Outcome={status:'indeterminate',error_code:'selected_file_effect_unknown'};
 try{
  const remote=await env.ACTIONS.execute(String(capability.manifest.action),
   {...meta,bytes:selected.bytes,invocation_id,
    contract_digest:capability.manifest.contract_digest,deployment_id:deployment,input_digest});
  if(remote.input_digest===input_digest&&remote.status==='rejected')
   result={status:'failed',error_code:'selected_file_provider_rejected'};
  else if(remote.input_digest===input_digest)
   result=reviewedResponse(remote,capability.manifest);
 }catch{/* Once the invocation is reserved, unknown delivery never retries. */}
 try{
  await env.DB.prepare(`INSERT INTO run_steps
    (run_id,step_id,status,output,error_code,updated_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(run_id,step_id) DO UPDATE SET status=excluded.status,
     output=excluded.output,error_code=excluded.error_code,updated_at=excluded.updated_at
    WHERE run_steps.status IN ('waiting','running')`)
   .bind(run.run_id,capability.step_id,result.status,
    result.output?JSON.stringify(result.output):null,result.error_code??null,Date.now()).run();
  try{
   const instance=await env.WORKFLOW.get(run.run_id);
   await instance.sendEvent?.({type:'selected-file-complete-'+capability.step_id,
    payload:{run_id:run.run_id}});
  }catch{/* The durable result, not the wake, is authoritative. */}
 }catch{return {run_id:run.run_id,status:'indeterminate' as const,
   error_code:'selected_file_receipt_unconfirmed'};}
 return {run_id:run.run_id,status:result.status,
  ...(result.output?{result:result.output}:{}),
  ...(result.error_code?{error_code:result.error_code}:{})};
}
