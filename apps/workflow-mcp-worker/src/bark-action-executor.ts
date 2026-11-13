import type {Env} from './store.ts';
import {isAuxiliaryBarkPair,type Plan,type Step} from './plan.ts';
import {reviewedActionDeployment,canonical,cloudflareActionManifest,TRUSTED_SIGNED_SESSION_WORKFLOW_PATHS} from './cloudflare-action-contract.ts';
import {evaluateArguments} from './plan.ts';
import {inspectPersistedGitHubActionAttempt} from './github-action-attempt-inspection.ts';
import {isDynamicMainAction} from './github-action-main.ts';
import {isWellFormedWorkflowGitHubRepository,isCurrentWorkflowGitHubAction,readWorkflowGitHubExecutor} from './workflow-github-executor.ts';
import {isPublishedGitHubActionApproved,type ReviewedGitHubAction} from './github-action-review.ts';
import {DOWNLOAD_COMPLETED_TEXT} from './download-notification-executor.ts';

/** Stateless Bark: the existing D1 reservation is the only send admission.
 * A prior reservation can never trigger another RPC; without receipts it is unknown.
 */
// The approved Plan and persisted physical Attempt establish the precise
// workflow ID. Only these existing business paths may carry signed receipts.
const NOTIFICATION_PATHS=new Set([
 '.github/workflows/chrome.yml',
 '.github/workflows/openlist.yml',
 '.github/workflows/download.yml',
]);
const trustedNotificationIdentity=(pinned:unknown,plan:Plan):boolean=>{
 if(!pinned||typeof pinned!=='object'||Array.isArray(pinned))return false;
 const action=pinned as ReviewedGitHubAction;
 return isWellFormedWorkflowGitHubRepository(action.repository)&&
   Number.isSafeInteger(action.repositoryId)&&action.repositoryId>0&&
   Number.isSafeInteger(action.workflowId)&&action.workflowId>0&&
   NOTIFICATION_PATHS.has(action.workflowPath)&&
   isPublishedGitHubActionApproved(plan.github_action_approvals,{
     repository:action.repository,repositoryId:action.repositoryId,
     workflowId:action.workflowId,workflowPath:action.workflowPath,
     commitSha:action.commitSha,type:action.type,contractDigest:action.contractDigest,
   });
};
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
  let download:{attempt_id:string;workflow_ref:string;child_id:string;repository:string}|undefined;
  if(downloadId!==undefined){
   const upstream=plan.steps.find(x=>x.id===downloadId);
   const template=upstream?.with.template as {id?:unknown;uses?:unknown;with?:{action?:unknown}}|undefined;
   const pinned=template?.with?.action as {repository?:unknown;repositoryId?:unknown;workflowId?:unknown;workflowPath?:unknown;type?:unknown;ref?:unknown;commitSha?:unknown}|undefined;
   if(!isCurrentWorkflowGitHubAction(readWorkflowGitHubExecutor(env.WORKFLOW_GITHUB_ACTION_IDENTITY),pinned as {repository:unknown;repositoryId:unknown}|undefined))
     return deny('github_action_executor_changed');
   const dynamicMain=typeof pinned?.ref==='string'&&
     isDynamicMainAction(pinned as Parameters<typeof isDynamicMainAction>[0],pinned.ref,plan.name);
   if(typeof downloadId!=='string'||!action.needs.includes(downloadId)||
      ctx?.steps[downloadId]?.status!=='succeeded'||upstream?.uses!=='flow.foreach'||
      upstream.with.max_items!==1||template?.uses!=='github.run'||typeof template.id!=='string'||
      !isWellFormedWorkflowGitHubRepository(pinned?.repository)||pinned.workflowPath!=='.github/workflows/download.yml'||
      (dynamicMain&&(!trustedNotificationIdentity(pinned,plan)||!['download','offline-download'].includes(plan.name)))||
      pinned.type!=='task'||typeof pinned.ref!=='string'||
      (!/^refs\/tags\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(pinned.ref)&&!dynamicMain)||
      typeof pinned.commitSha!=='string'||!/^[a-f0-9]{40}$/.test(pinned.commitSha))
    return deny('untrusted_download_reference');
   const childId=downloadId+'_0_'+template.id;
   const workflowRef=pinned.repository+'/'+pinned.workflowPath+'@'+pinned.ref;
   const proof=await db.prepare(`SELECT a.attempt_id FROM step_attempts a
     JOIN run_steps child ON child.run_id=a.run_id AND child.step_id=a.step_id
     JOIN run_steps parent ON parent.run_id=a.run_id AND parent.step_id=?
     WHERE a.run_id=? AND a.step_id=? AND a.capability_id='github.action'
      AND a.state='succeeded' AND child.status='succeeded' AND parent.status='succeeded'
      AND a.repository=? AND a.workflow_ref=?
      AND a.repository_id=? AND a.ref=?
      AND ((?=1 AND length(a.resolved_sha)=40
            AND a.resolved_sha NOT GLOB '*[^0-9a-f]*')
        OR (?=0 AND a.resolved_sha IS NULL))
      AND a.owner_run_id=a.candidate_run_id
      AND a.owner_run_attempt=a.candidate_run_attempt
      AND NOT EXISTS(SELECT 1 FROM github_action_cancellations c WHERE c.attempt_id=a.attempt_id)`)
      .bind(downloadId,runId,childId,pinned.repository,workflowRef,String(pinned.repositoryId),
        pinned.ref,dynamicMain?1:0,dynamicMain?1:0).first<{attempt_id:string}>();
   if(!proof)return deny('download_completion_unverified');
   download={attempt_id:proof.attempt_id,workflow_ref:workflowRef,child_id:childId,repository:pinned.repository};
  }
  // The optional manual business -> Bark pair may consume only a durable,
  // independently granted Provider receipt from the same Run. Never use a
  // caller-provided output object or EnvShare secret as notification content.
  let paired:{sourceId:string;invocationId:string;contractDigest:string;
    title:string;body:string;url?:string}|undefined;
  if(isAuxiliaryBarkPair(plan.steps)&&plan.steps[1]?.id===action.id){
   const business=plan.steps[0]!;
   const kind=business.with.provider as 'dub'|'envshare'|'litterbox';
   const contract=await cloudflareActionManifest(kind);
   if(business.with.contract_digest!==contract.contract_digest||
      !plan.cloudflare_action_approvals?.some(g=>g.provider===kind&&
        g.action===contract.action&&g.contract_digest===contract.contract_digest))
     return deny('untrusted_business_reference');
   const source=await db.prepare(`SELECT s.status,s.output,i.invocation_id,i.contract_digest
     FROM run_steps s JOIN cloudflare_action_invocations i
      ON s.run_id=i.run_id AND s.step_id=i.step_id
     WHERE s.run_id=? AND s.step_id=?`)
     .bind(runId,business.id).first<{status:string;output:string|null;
       invocation_id:string;contract_digest:string}>();
   if(source?.status!=='succeeded'||source.contract_digest!==contract.contract_digest||
      !source.output)return deny('untrusted_business_reference');
   let value:Record<string,unknown>;
   try{
    const parsed=JSON.parse(source.output) as unknown;
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('invalid');
    value=parsed as Record<string,unknown>;
   }catch{return deny('untrusted_business_result');}
   if(value.status!=='accepted')return deny('untrusted_business_result');
   const inputsRow=await db.prepare('SELECT inputs FROM runs WHERE id=?')
     .bind(runId).first<{inputs:string}>();
   let inputs:Record<string,unknown>={};
   try{
    const data=JSON.parse(inputsRow?.inputs??'{}') as unknown;
    if(data&&typeof data==='object'&&!Array.isArray(data))inputs=data as Record<string,unknown>;
   }catch{return deny('untrusted_business_result');}
   let details:{title:string;body:string;url?:string};
   if(kind==='dub'){
    if(typeof value.short_link!=='string'||
      !/^https:\/\/dub\.sh\/[A-Za-z0-9_-]{3,64}$/.test(value.short_link))
      return deny('untrusted_business_result');
    details={title:'Short link created',body:'Short link created successfully',url:value.short_link};
   }else if(kind==='litterbox'){
    if(typeof value.download_url!=='string'||value.download_url.length>512||
       !/^https:\/\/(?:litterbox|litter)\.catbox\.moe\/[A-Za-z0-9._%/-]+$/.test(value.download_url)||
       typeof inputs.time!=='string'||!['1h','12h','24h','72h'].includes(inputs.time))
      return deny('untrusted_business_result');
    details={title:'Temporary file uploaded',body:'File is available for '+inputs.time,
      url:value.download_url};
   }else{
    if(typeof value.share_id!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{16,32}$/.test(value.share_id)||
       !Number.isSafeInteger(inputs.ttl)||!Number.isSafeInteger(inputs.reads)||
       Number(inputs.ttl)<60||Number(inputs.ttl)>604800||
       Number(inputs.reads)<1||Number(inputs.reads)>10)
      return deny('untrusted_business_result');
    details={title:'Secure share created',
      body:'Encrypted share created (TTL '+inputs.ttl+'s, max reads '+inputs.reads+'). Retrieve its link with the one-time delivery key.'};
   }
   paired={sourceId:business.id,invocationId:source.invocation_id,
     contractDigest:contract.contract_digest,...details};
  }
  let ready:{attempt_id:string;session_url:string;repository:string;workflow_ref:string}|undefined;
  let trustedWorkflowRef:string|undefined;
  if(sourceId!==undefined){
   const source=plan.steps.find(x=>x.id===sourceId);
   const pinned=source?.with.action as {repository?:unknown;repositoryId?:unknown;
     workflowId?:unknown;workflowPath?:unknown;type?:unknown;ref?:unknown;commitSha?:unknown}|undefined;
   if(!isCurrentWorkflowGitHubAction(readWorkflowGitHubExecutor(env.WORKFLOW_GITHUB_ACTION_IDENTITY),pinned as {repository:unknown;repositoryId:unknown}|undefined))
     return deny('github_action_executor_changed');
   // Keep immutable Tag grants, and allow only the five existing reviewed
   // main-branch identities. Bark's trusted path list further limits this to
   // Chrome; the physical Attempt inspector verifies the frozen main SHA.
   const trustedRef=typeof pinned?.ref==='string'&&
     (/^refs\/tags\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(pinned.ref)||
      (typeof pinned.workflowPath==='string'&&
       isDynamicMainAction(pinned as Parameters<typeof isDynamicMainAction>[0],pinned.ref,plan.name)&&
       typeof pinned.commitSha==='string'&&/^[a-f0-9]{40}$/.test(pinned.commitSha)));
   if(typeof sourceId!=='string'||!action.needs.includes(sourceId)||
      source?.uses!=='github.run'||!isWellFormedWorkflowGitHubRepository(pinned?.repository)||
      (pinned?.ref==='refs/heads/main'&&(!trustedNotificationIdentity(pinned,plan)||
       plan.name!==String(pinned.workflowPath).split('/').at(-1)?.replace(/\.ya?ml$/,'')))||
      (typeof pinned.workflowPath!=='string'||!TRUSTED_SIGNED_SESSION_WORKFLOW_PATHS.has(pinned.workflowPath))||pinned.type!=='session'||
      !trustedRef)
    return deny('untrusted_session_reference');
   trustedWorkflowRef=pinned.repository+'/'+pinned.workflowPath+'@'+pinned.ref;
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
      current.repository!==pinned.repository||current.workflow_ref!==trustedWorkflowRef)
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
   if(paired){
    if(Object.keys(values).length!==1||values.body!=='Completed')
      throw Error('untrusted_paired_notification');
    values.title=paired.title;
    values.body=paired.body;
    if(paired.url)values.url=paired.url;
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
       AND a.repository=? AND a.workflow_ref=?
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
      AND a.repository=? AND a.workflow_ref=?
      AND a.owner_run_id=a.candidate_run_id
      AND a.owner_run_attempt=a.candidate_run_attempt
      AND NOT EXISTS(SELECT 1 FROM github_action_cancellations c WHERE c.attempt_id=a.attempt_id))`:'';
  // Recheck the original successful Provider reservation atomically with
  // the Bark reservation; no duplicate sends after an unknown ACK.
  const pairedFence=paired?`AND EXISTS(
    SELECT 1 FROM run_steps s JOIN cloudflare_action_invocations i
     ON i.run_id=s.run_id AND i.step_id=s.step_id
    WHERE s.run_id=? AND s.step_id=? AND s.status='succeeded'
      AND i.invocation_id=? AND i.contract_digest=?)`:'';
  const fence=await db.prepare(`INSERT OR IGNORE INTO cloudflare_action_invocations
    (run_id,step_id,invocation_id,source_attempt_id,input_digest,
     binding_generation,contract_digest,deployment_id,created_at)
    SELECT ?,?,?,?,?,0,?,?,? WHERE EXISTS(
      SELECT 1 FROM runs WHERE id=? AND outcome='running')
    ${sourceFence}
    ${downloadFence}
    ${pairedFence}
    AND EXISTS(SELECT 1 FROM cloudflare_action_gate WHERE id=1 AND state='open')
    AND NOT EXISTS(SELECT 1 FROM cloudflare_action_cancellations c
      WHERE c.run_id=? AND c.step_id=?)`)
    .bind(runId,action.id,id,ready?.attempt_id??download?.attempt_id??paired?.invocationId??id,inputDigest,manifest.contract_digest,version,
      Date.now(),runId,...(ready?[runId,sourceId,ready.session_url,ready.attempt_id,ready.repository,trustedWorkflowRef]:[]),
      ...(download?[downloadId,runId,download.child_id,download.attempt_id,download.repository,download.workflow_ref]:[]),
      ...(paired?[runId,paired.sourceId,paired.invocationId,paired.contractDigest]:[]),
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
