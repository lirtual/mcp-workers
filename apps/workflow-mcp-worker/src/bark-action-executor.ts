import type {Env} from './store.ts';
import type {Plan,Step} from './plan.ts';
import {reviewedActionDeployment,canonical,cloudflareActionManifest,TRUSTED_SIGNED_SESSION_WORKFLOW_PATHS} from './cloudflare-action-contract.ts';
import {evaluateArguments} from './plan.ts';
import {inspectPersistedGitHubActionAttempt} from './github-action-attempt-inspection.ts';
import {isDynamicMainAction} from './github-action-main.ts';
import {DOWNLOAD_COMPLETED_TEXT} from './download-notification-executor.ts';

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
 ctx?:{inputs:Record<string,unknown>;steps:Record<string,{status:string;output?:unknown}>},
 inspect:typeof inspectPersistedGitHubActionAttempt=inspectPersistedGitHubActionAttempt):Promise<Result>{
 const provider=env.ACTIONS;
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
  if(!provider)return deny('cloudflare_provider_not_configured');
  // Grant's original deployment_id remains immutable audit evidence, not a new-send pin.
  // Optional reviewed Session: resolve its signed Ready URL from D1,
  // not from a caller-supplied URL or an undeclared Step output.
  const sourceId=(action.with.input as {session_step_id?:unknown}|undefined)?.session_step_id;
  const downloadId=(action.with.input as {download_step_id?:unknown}|undefined)?.download_step_id;
  if(sourceId!==undefined&&downloadId!==undefined)return deny('untrusted_download_reference');
  let download:{attempt_id:string;workflow_ref:string;child_id:string}|undefined;
  if(downloadId!==undefined){
   const upstream=plan.steps.find(x=>x.id===downloadId);
   const template=upstream?.with.template as {id?:unknown;uses?:unknown;with?:{action?:unknown}}|undefined;
   const pinned=template?.with?.action as {repository?:unknown;workflowPath?:unknown;type?:unknown;ref?:unknown;commitSha?:unknown}|undefined;
   if(typeof downloadId!=='string'||!action.needs.includes(downloadId)||
      ctx?.steps[downloadId]?.status!=='succeeded'||upstream?.uses!=='flow.foreach'||
      upstream.with.max_items!==1||template?.uses!=='github.run'||typeof template.id!=='string'||
      pinned?.repository!=='lirtual/github-actions'||pinned.workflowPath!=='.github/workflows/download.yml'||
      pinned.type!=='task'||typeof pinned.ref!=='string'||
      !/^refs\/tags\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(pinned.ref)||
      typeof pinned.commitSha!=='string'||!/^[a-f0-9]{40}$/.test(pinned.commitSha))
    return deny('untrusted_download_reference');
   const childId=downloadId+'_0_'+template.id;
   const workflowRef='lirtual/github-actions/'+pinned.workflowPath+'@'+pinned.ref;
   const proof=await db.prepare(`SELECT a.attempt_id FROM step_attempts a
     JOIN run_steps child ON child.run_id=a.run_id AND child.step_id=a.step_id
     JOIN run_steps parent ON parent.run_id=a.run_id AND parent.step_id=?
     WHERE a.run_id=? AND a.step_id=? AND a.capability_id='github.action'
      AND a.state='succeeded' AND child.status='succeeded' AND parent.status='succeeded'
      AND a.repository='lirtual/github-actions' AND a.workflow_ref=?
      AND a.owner_run_id=a.candidate_run_id
      AND a.owner_run_attempt=a.candidate_run_attempt
      AND NOT EXISTS(SELECT 1 FROM github_action_cancellations c WHERE c.attempt_id=a.attempt_id)`)
      .bind(downloadId,runId,childId,workflowRef).first<{attempt_id:string}>();
   if(!proof)return deny('download_completion_unverified');
   download={attempt_id:proof.attempt_id,workflow_ref:workflowRef,child_id:childId};
  }
  let ready:{attempt_id:string;session_url:string;repository:string;workflow_ref:string}|undefined;
  let trustedWorkflowRef:string|undefined;
  if(sourceId!==undefined){
   const source=plan.steps.find(x=>x.id===sourceId);
   const pinned=source?.with.action as {repository?:unknown;repositoryId?:unknown;
     workflowId?:unknown;workflowPath?:unknown;type?:unknown;ref?:unknown;commitSha?:unknown}|undefined;
   // Keep immutable Tag grants, and allow only the five existing reviewed
   // main-branch identities. Bark's trusted path list further limits this to
   // Chrome; the physical Attempt inspector verifies the frozen main SHA.
   const trustedRef=typeof pinned?.ref==='string'&&
     (/^refs\/tags\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(pinned.ref)||
      (typeof pinned.workflowPath==='string'&&
       isDynamicMainAction(pinned as Parameters<typeof isDynamicMainAction>[0],pinned.ref,plan.name)&&
       typeof pinned.commitSha==='string'&&/^[a-f0-9]{40}$/.test(pinned.commitSha)));
   if(typeof sourceId!=='string'||!action.needs.includes(sourceId)||
      source?.uses!=='github.run'||pinned?.repository!=='lirtual/github-actions'||
      (typeof pinned.workflowPath!=='string'||!TRUSTED_SIGNED_SESSION_WORKFLOW_PATHS.has(pinned.workflowPath))||pinned.type!=='session'||
      !trustedRef)
    return deny('untrusted_session_reference');
   trustedWorkflowRef='lirtual/github-actions/'+pinned.workflowPath+'@'+pinned.ref;
   const current=await db.prepare(`SELECT a.attempt_id,s.session_url,a.repository,a.workflow_ref
     FROM session_executions s JOIN step_attempts a
     ON a.run_id=s.run_id AND a.step_id=s.step_id
     WHERE s.run_id=? AND s.step_id=? AND s.state='ready'
      AND a.capability_id='github.action' AND a.state='claimed'
      AND a.owner_run_id=a.candidate_run_id
      AND a.owner_run_attempt=a.candidate_run_attempt
      AND NOT EXISTS(SELECT 1 FROM github_action_cancellations c
        WHERE c.attempt_id=a.attempt_id)`)
    .bind(runId,sourceId).first<typeof ready>();
   const raw=current?.session_url;
   if(!current||typeof raw!=='string'||raw.length>180||
      !/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com\/?$/.test(raw)||
      current.repository!=='lirtual/github-actions'||current.workflow_ref!==trustedWorkflowRef)
    return deny('session_ready_not_trusted');
   const canonical=new URL(raw).href;
   if(canonical!==raw&&canonical!==raw+'/')
    return deny('session_ready_not_trusted');
   if(!env.WORKFLOW_GITHUB_DISPATCH_TOKEN)return deny('session_physical_unconfirmed');
   let live;
   try{live=await inspect(db,current.attempt_id,env.WORKFLOW_GITHUB_DISPATCH_TOKEN);}
   catch{return deny('session_physical_unconfirmed');}
   if(live.state!=='running')return deny('session_physical_unconfirmed');
   ready=current;
  }
  let notification:Record<string,unknown>;
  try{
   if(!ctx)throw Error('missing_context');
   const source=(action.with.input as {notification?:unknown}|undefined)?.notification;
   const evaluated=evaluateArguments(source,ctx) as unknown;
   if(!evaluated||typeof evaluated!=='object'||Array.isArray(evaluated))
    throw Error('invalid_bark_notification');
   const values=evaluated as Record<string,unknown>;
   if(download&&(Object.keys(values).length!==1||values.body!==DOWNLOAD_COMPLETED_TEXT))
    throw Error('untrusted_download_notification');
   if(ready){
    if(Object.hasOwn(values,'url'))throw Error('untrusted_session_url');
    values.url=new URL(ready.session_url).href;
   }
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
  const version=reviewedActionDeployment(bound,manifest.contract_digest);
  if(!version)return deny('cloudflare_provider_identity_mismatch');
  const payload=JSON.stringify(canonical(notification));
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(payload));
  const inputDigest=Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
  const id=crypto.randomUUID();
  // Reuse existing D1 fence. A signed Session URL may dispatch only while
  // that same immutable physical Attempt is still claimed and Ready.
  const sourceFence=ready?`AND EXISTS(
      SELECT 1 FROM session_executions s JOIN step_attempts a
       ON a.run_id=s.run_id AND a.step_id=s.step_id
      WHERE s.run_id=? AND s.step_id=? AND s.state='ready'
       AND s.session_url=? AND a.attempt_id=? AND a.state='claimed'
       AND a.capability_id='github.action'
       AND a.repository='lirtual/github-actions' AND a.workflow_ref=?
       AND a.owner_run_id=a.candidate_run_id
       AND a.owner_run_attempt=a.candidate_run_attempt
       AND NOT EXISTS(SELECT 1 FROM github_action_cancellations c
        WHERE c.attempt_id=a.attempt_id))`:'';
  const downloadFence=download?`AND EXISTS(
    SELECT 1 FROM step_attempts a
    JOIN run_steps child ON child.run_id=a.run_id AND child.step_id=a.step_id
    JOIN run_steps parent ON parent.run_id=a.run_id AND parent.step_id=?
    WHERE a.run_id=? AND a.step_id=? AND a.attempt_id=?
      AND a.capability_id='github.action' AND a.state='succeeded'
      AND child.status='succeeded' AND parent.status='succeeded'
      AND a.repository='lirtual/github-actions' AND a.workflow_ref=?
      AND a.owner_run_id=a.candidate_run_id
      AND a.owner_run_attempt=a.candidate_run_attempt
      AND NOT EXISTS(SELECT 1 FROM github_action_cancellations c WHERE c.attempt_id=a.attempt_id))`:'';
  const fence=await db.prepare(`INSERT OR IGNORE INTO cloudflare_action_invocations
    (run_id,step_id,invocation_id,source_attempt_id,input_digest,
     binding_generation,contract_digest,deployment_id,created_at)
    SELECT ?,?,?,?,?,0,?,?,? WHERE EXISTS(
      SELECT 1 FROM runs WHERE id=? AND outcome='running')
    ${sourceFence}
    ${downloadFence}
    AND EXISTS(SELECT 1 FROM cloudflare_action_gate WHERE id=1 AND state='open')
    AND NOT EXISTS(SELECT 1 FROM cloudflare_action_cancellations c
      WHERE c.run_id=? AND c.step_id=?)`)
    .bind(runId,action.id,id,ready?.attempt_id??download?.attempt_id??id,inputDigest,manifest.contract_digest,version,
      Date.now(),runId,...(ready?[runId,sourceId,ready.session_url,ready.attempt_id,trustedWorkflowRef]:[]),
      ...(download?[downloadId,runId,download.child_id,download.attempt_id,download.workflow_ref]:[]),
      runId,action.id).run();
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
