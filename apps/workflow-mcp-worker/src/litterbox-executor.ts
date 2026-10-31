import {WorkflowService,StateError,type Env} from './store.ts';
import {cloudflareActionManifest,canonical} from './cloudflare-action-contract.ts';
import {readBoundedAttachment,approvedAttachmentUrl,type ChatGptFile} from './litterbox-file-source.ts';
import type {Plan} from './plan.ts';

const TTL=new Set(['1h','12h','24h','72h']);
const FILE_NAME=/^[^\/\\\x00-\x1f\x7f]{1,160}$/u;
type Receipt={status:'succeeded'|'failed'|'indeterminate';error_code?:string;
 output?:{status:'accepted';download_url:string}};
const hash=async(o:unknown)=>{
 const bytes=new TextEncoder().encode(JSON.stringify(canonical(o)));
 return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),
  b=>b.toString(16).padStart(2,'0')).join('');
};
const safeLink=(v:unknown):v is string=>{
 if(typeof v!=='string'||v.length>512)return false;
 try{
  const u=new URL(v);
  return u.protocol==='https:'&&['litterbox.catbox.moe','litter.catbox.moe'].includes(u.hostname)&&
   !u.port&&!u.username&&!u.password&&!u.search&&!u.hash&&
   /^\/[A-Za-z0-9._%/-]+$/.test(u.pathname)&&u.pathname!=='/'&&u.href===v;
 }catch{return false;}
};
export const isLitterboxPlan=(p:Plan):boolean=>{
 const s=p.steps?.[0];
 if(p.steps.length!==1||p.triggers?.length||p.saga||
    (p.inputs&&Object.keys(p.inputs).length!==0)||
    p.cloudflare_execution_approved!==true||
    s?.uses!=='action.run'||s.needs.length!==0||s.if!==undefined||
    s.approval!==undefined||s.needs_policy!==undefined||
    s.with.executor!=='cloudflare'||s.with.provider!=='litterbox'||
    s.with.action!=='litterbox.upload_file')return false;
 const refs=s.with.input;
 if(!refs||typeof refs!=='object'||Array.isArray(refs))return false;
 const data=refs as Record<string,unknown>;
 const fields=['file_name','size_bytes','sha256','time'];
 if(Object.keys(data).sort().join(',')!==fields.sort().join(','))return false;
 return fields.every(k=>{
   const v=data[k];
   return v!==null&&typeof v==='object'&&!Array.isArray(v)&&
    Object.keys(v).length===1&&(v as {ref?:unknown}).ref==='inputs.'+k;
 });
};
export async function recordedLitterboxStep(db:D1Database,runId:string,stepId:string):
 Promise<Receipt|null>{
 const row=await db.prepare(`SELECT s.status,s.output,s.error_code FROM run_steps s
  JOIN cloudflare_action_invocations a ON a.run_id=s.run_id AND a.step_id=s.step_id
  WHERE s.run_id=? AND s.step_id=?`).bind(runId,stepId)
  .first<{status:string;output:string|null;error_code:string|null}>();
 if(!row||!['succeeded','failed','indeterminate'].includes(row.status))return null;
 if(row.status==='succeeded'){
  let data:{status?:string;download_url?:string}|null=null;
  try{data=row.output?JSON.parse(row.output):null;}catch{}
  if(data?.status!=='accepted'||!safeLink(data.download_url))
   return {status:'indeterminate',error_code:'litterbox_receipt_invalid'};
  return {status:'succeeded',output:{status:'accepted',download_url:data.download_url}};
 }
 return {status:row.status as 'failed'|'indeterminate',error_code:row.error_code??undefined};
}

/** Execute only the already published, one-step manual Litterbox Plan.
 * The native Workflow waits for this single D1 receipt and never POSTs.
 * File locator/ID/bytes never enter D1 or native events.
 */
export async function startLitterboxUpload(env:Env,args:{
 workflow_id:string;file:ChatGptFile;time?:string;idempotency_key:string;
}):Promise<{run_id:string;status:'succeeded'|'failed'|'indeterminate';download_url?:string;error_code?:string}>{
 const time=args.time??'24h';
 if(!TTL.has(time)||typeof args.idempotency_key!=='string'||
    !/^[A-Za-z0-9_-]{1,128}$/.test(args.idempotency_key)||
    !approvedAttachmentUrl(args.file))throw new StateError('litterbox_invalid_file_or_policy');
 const file_name=args.file.file_name??'upload.bin';
 if(!FILE_NAME.test(file_name)||file_name.trim()!==file_name||file_name==='.'||file_name==='..'||file_name.startsWith('.'))
  throw new StateError('litterbox_invalid_filename');
 const wf=await env.DB.prepare(`SELECT w.state,w.active_version_id,v.plan
   FROM workflows w JOIN workflow_versions v ON v.id=w.active_version_id
   WHERE w.id=? AND w.deleted_at IS NULL`).bind(args.workflow_id)
  .first<{state:string;active_version_id:string;plan:string}>();
 if(!wf||wf.state!=='active')throw new StateError('workflow_not_active');
 let plan:Plan;
 try{plan=JSON.parse(wf.plan) as Plan;}catch{throw new StateError('published_plan_invalid');}
 if(!isLitterboxPlan(plan))throw new StateError('litterbox_published_plan_required');
 const action=plan.steps[0]!,manifest=await cloudflareActionManifest('litterbox');
 if(action.with.contract_digest!==manifest.contract_digest||
   plan.cloudflare_action_approvals?.length!==1||
   !plan.cloudflare_action_approvals.some(g=>g.provider==='litterbox'&&
    g.action===manifest.action&&g.executor==='cloudflare'&&
    g.contract_digest===manifest.contract_digest&&g.deployment_id===env.ACTIONS_DEPLOYMENT_ID))
  throw new StateError('litterbox_approval_required');
 if(!env.ACTIONS||!env.ACTIONS_DEPLOYMENT_ID)
  throw new StateError('cloudflare_provider_not_configured');
 let identity;
 try{identity=await env.ACTIONS.getContract(manifest.action,manifest.contract_digest);}
 catch{throw new StateError('cloudflare_provider_identity_unconfirmed');}
 if(identity.deployment_id!==env.ACTIONS_DEPLOYMENT_ID||
   identity.contract_digest!==manifest.contract_digest)
  throw new StateError('cloudflare_provider_identity_mismatch');
 // Allowlisted download, bounded byte count and SHA256, memory only.
 const selected=await readBoundedAttachment(args.file);
 const meta={file_name,size_bytes:selected.size_bytes,sha256:selected.sha256,time};
 const run=await new WorkflowService(env).start(args.workflow_id,meta,args.idempotency_key,undefined,true);
 if(run.start_state!=='started')
  return {run_id:run.run_id,status:'indeterminate',error_code:'litterbox_run_start_unconfirmed'};
 const invocation_id=crypto.randomUUID(),input_digest=await hash(meta);
 const reserved=await env.DB.prepare(`INSERT OR IGNORE INTO cloudflare_action_invocations
   (run_id,step_id,invocation_id,source_attempt_id,input_digest,
    binding_generation,contract_digest,deployment_id,created_at)
   SELECT ?,?,?,?, ?,0,?,?,? WHERE EXISTS(
      SELECT 1 FROM runs r JOIN workflows w ON w.id=r.workflow_id
      WHERE r.id=? AND r.version_id=? AND r.outcome IN ('queued','running')
        AND w.active_version_id=? AND w.state='active' AND w.deleted_at IS NULL)
   AND EXISTS(SELECT 1 FROM cloudflare_action_gate WHERE id=1 AND state='open')
   AND NOT EXISTS(SELECT 1 FROM cloudflare_action_cancellations WHERE run_id=? AND step_id=?)`)
  .bind(run.run_id,action.id,invocation_id,invocation_id,input_digest,
    manifest.contract_digest,env.ACTIONS_DEPLOYMENT_ID,Date.now(),run.run_id,
    wf.active_version_id,wf.active_version_id,run.run_id,action.id).run();
 if(reserved.meta.changes!==1)throw new StateError('litterbox_dispatch_not_admitted');
 let result:Receipt={status:'indeterminate',error_code:'litterbox_outcome_unknown'};
 try{
  const remote=await env.ACTIONS.execute(manifest.action,{
   ...meta,bytes:selected.bytes,invocation_id,contract_digest:manifest.contract_digest,
   deployment_id:env.ACTIONS_DEPLOYMENT_ID,input_digest,
  }) as {status:string;input_digest:string;download_url?:string};
  if(remote.input_digest===input_digest&&remote.status==='accepted'&&safeLink(remote.download_url))
   result={status:'succeeded',output:{status:'accepted',download_url:remote.download_url}};
  else if(remote.input_digest===input_digest&&remote.status==='rejected')
   result={status:'failed',error_code:'litterbox_rejected'};
 }catch{/* Unknown effect remains fenced; never replay. */}
 try{
  await env.DB.prepare(`INSERT INTO run_steps
   (run_id,step_id,status,output,error_code,updated_at) VALUES(?,?,?,?,?,?)
   ON CONFLICT(run_id,step_id) DO UPDATE SET status=excluded.status,
     output=excluded.output,error_code=excluded.error_code,
     updated_at=excluded.updated_at
   WHERE run_steps.status IN ('waiting','running')`)
  .bind(run.run_id,action.id,result.status,
    result.output?JSON.stringify(result.output):null,result.error_code??null,Date.now()).run();
  // The event carries no bytes or signed URL. A lost signal never retries POST.
  try{
   const instance=await env.WORKFLOW.get(run.run_id);
   await instance.sendEvent?.({type:'litterbox-complete-'+action.id,payload:{run_id:run.run_id}});
  }catch{/* Result is already durable; native waiter may time out. */}
 }catch{return {run_id:run.run_id,status:'indeterminate',error_code:'litterbox_receipt_unconfirmed'};}
 return {run_id:run.run_id,status:result.status,
  ...(result.output?{download_url:result.output.download_url}:{}),
  ...(result.error_code?{error_code:result.error_code}:{})};
}
