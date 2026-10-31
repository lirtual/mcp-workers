import {runDubAction} from './dub-action-executor.ts';
import {runEnvshareAction} from './envshare-action-executor.ts';
import {runDownloadNotification} from './download-notification-executor.ts';
import {runGenericTextNotification} from './generic-weixin-executor.ts';
import {runBarkAction} from './bark-action-executor.ts';
import type {Env} from './store.ts';
import type {Plan,Step} from './plan.ts';
import {cloudflareActionManifest} from './cloudflare-action-contract.ts';
import {inspectPersistedGitHubActionAttempt} from './github-action-attempt-inspection.ts';

type Result={status:'succeeded'|'failed'|'indeterminate';error_code?:string;output?:{status:string}};
type Frozen={invocation_id:string;source_attempt_id:string;input_digest:string;
 binding_generation:number;contract_digest:string;deployment_id:string};
type Source={attempt_id:string;session_url:string;repository:string;workflow_ref:string};
const URL_PATTERN=/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com\/?$/;
const denied=(code:string):Result=>({status:'failed',error_code:code});
const uncertain=(code='cloudflare_outcome_unknown'):Result=>({status:'indeterminate',error_code:code});
const digest=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest(
 'SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
const receipt=(status:unknown):Result=>
 status==='accepted'?{status:'succeeded',output:{status:'accepted'}}:
 status==='rejected'?{status:'failed',error_code:'weixin_rejected'}:uncertain();

/** Historical receipt query is pure even after unbind. Missing is unknown. */
async function recover(env:Env,row:Frozen):Promise<Result>{
 try{
  const query={invocation_id:row.invocation_id,binding_generation:row.binding_generation,
   input_digest:row.input_digest};
  // Only historical reads may use the temporary old binding. No new sends do.
  const value=env.ACTIONS?await env.ACTIONS.getReceipt('weixin.send_text',query):
   await env.WEIXIN_ACTION_PROVIDER!.getReceipt(query);
  return receipt(value.status);
 }catch{return uncertain('cloudflare_receipt_unconfirmed');}
}

/** At-most-one side-effecting RPC per Run Step. First reserve in D1, then send.
 * On crash/replay never send again. No plaintext URL is checkpointed.
 */
export async function runPublishedCloudflareAction(
 env:Env,plan:Plan,action:Step,runId:string,
 inspect:typeof inspectPersistedGitHubActionAttempt=inspectPersistedGitHubActionAttempt,
 ctx?:{inputs:Record<string,unknown>;steps:Record<string,{status:string;output?:unknown}>},
):Promise<Result>{
 if(action.with.provider==='dub')return runDubAction(env,plan,action,runId,ctx);
 if(action.with.provider==='envshare')return runEnvshareAction(env,plan,action,runId,ctx);
 if(action.with.provider==='bark')return runBarkAction(env,plan,action,runId,ctx);
 if(action.with.action==='weixin.notify_download')
   return runDownloadNotification(env,plan,action,runId,ctx);
 const oldGeneric=await cloudflareActionManifest('generic');
 const unifiedGeneric=await cloudflareActionManifest('unified-generic');
 const oldV2=action.with.contract_digest===oldGeneric.contract_digest;
 const newV3=action.with.contract_digest===unifiedGeneric.contract_digest;
 const isGeneric=oldV2||newV3;
 if(isGeneric&&!(action.with.input as {session_step_id?:string}|undefined)?.session_step_id)
   return runGenericTextNotification(env,plan,action,runId,ctx);
 const provider=oldV2?env.WEIXIN_ACTION_PROVIDER:env.ACTIONS;
 const version=oldV2?env.WEIXIN_ACTION_DEPLOYMENT_ID:env.ACTIONS_DEPLOYMENT_ID;
 const manifest=oldV2?oldGeneric:newV3?unifiedGeneric:await cloudflareActionManifest();
 const db=env.DB;
 const existing=()=>db.prepare(`SELECT invocation_id,source_attempt_id,input_digest,
  binding_generation,contract_digest,deployment_id
  FROM cloudflare_action_invocations WHERE run_id=? AND step_id=?`)
  .bind(runId,action.id).first<Frozen>();
 try{
  const prior=await existing();
  if(prior){
    // History is pinned to the *original* immutable Plan grant, not latest
    // deployed Action Worker. This branch never calls execute or sends HTTP.
    const approved=plan.cloudflare_execution_approved===true&&
      action.uses==='action.run'&&action.with.executor==='cloudflare'&&
      action.with.provider==='weixin'&&action.with.action==='weixin.send_text'&&
      action.with.contract_digest===prior.contract_digest&&
      plan.cloudflare_action_approvals?.some(g=>g.executor==='cloudflare'&&
        g.provider==='weixin'&&g.action==='weixin.send_text'&&
        g.contract_digest===prior.contract_digest&&g.deployment_id===prior.deployment_id);
    if(!approved||!/^[a-f0-9]{64}$/.test(prior.input_digest)||
       !Number.isSafeInteger(prior.binding_generation)||prior.binding_generation<1||
       !/^[0-9a-f-]{36}$/i.test(prior.source_attempt_id))
      return uncertain('cloudflare_invocation_conflict');
    return recover(env,prior);
  }
 const grant=plan.cloudflare_action_approvals?.find(g=>g.executor==='cloudflare'&&
   g.provider===manifest.provider&&g.action===manifest.action&&
   g.contract_digest===manifest.contract_digest&&g.deployment_id===version);
 if(plan.cloudflare_execution_approved!==true||action.uses!=='action.run'||
    action.with.executor!=='cloudflare'||action.with.provider!==manifest.provider||
    action.with.action!==manifest.action||action.with.contract_digest!==manifest.contract_digest||
    !grant)return denied('cloudflare_action_approval_required');
 if(!provider||!version)return denied('cloudflare_provider_not_configured');
 const sourceId=(action.with.input as {session_step_id?:unknown}|undefined)?.session_step_id;
 const source=plan.steps.find(x=>x.id===sourceId);
 const pinned=source?.with.action as {repository?:unknown;workflowPath?:unknown;type?:unknown}|undefined;
 if(typeof sourceId!=='string'||!action.needs.includes(sourceId)||
   source?.uses!=='github.run'||pinned?.repository!=='lirtual/github-actions'||
   pinned.workflowPath!=='.github/workflows/openlist.yml'||pinned.type!=='session')
  return denied('untrusted_session_reference');
  // Independently identify the live bound Worker before first dispatch.
  // The Provider repeats this pin check inside sendText against its own
  // runtime Version Metadata to close the read-then-dispatch deployment race.
  let boundIdentity;
  try{boundIdentity=oldV2?await env.WEIXIN_ACTION_PROVIDER!.getGenericContract():
     await env.ACTIONS!.getContract(manifest.action,manifest.contract_digest);}
  catch{return denied('cloudflare_provider_identity_unconfirmed');}
  if(boundIdentity.deployment_id!==version||boundIdentity.contract_digest!==manifest.contract_digest)
    return denied('cloudflare_provider_identity_mismatch');
  const current=await db.prepare(`SELECT a.attempt_id,s.session_url,a.repository,a.workflow_ref
   FROM session_executions s JOIN step_attempts a
    ON a.run_id=s.run_id AND a.step_id=s.step_id
   WHERE s.run_id=? AND s.step_id=? AND s.state='ready'
    AND a.capability_id='github.action' AND a.state='claimed'
    AND a.owner_run_id=a.candidate_run_id AND a.owner_run_attempt=a.candidate_run_attempt
    AND NOT EXISTS(SELECT 1 FROM github_action_cancellations c
      WHERE c.attempt_id=a.attempt_id)`)
   .bind(runId,sourceId).first<Source>();
  if(!current||typeof current.session_url!=='string'||
    !URL_PATTERN.test(current.session_url)||current.session_url.length>180||
    current.repository!=='lirtual/github-actions'||
    !current.workflow_ref.startsWith('lirtual/github-actions/.github/workflows/openlist.yml@'))
   return denied('session_ready_not_trusted');
  // Cloudflare Quick Tunnel's signed Ready callback uses a bare root origin
  // without a slash. Normalize only that equivalent form for Provider digest
  // and RPC; keep the signed raw D1 URL in the reservation/race predicate.
  const canonicalSessionUrl=new URL(current.session_url).href;
  if(canonicalSessionUrl!==current.session_url&&
     canonicalSessionUrl!==current.session_url+'/')
    return denied('session_ready_not_trusted');
  if(!env.WORKFLOW_GITHUB_DISPATCH_TOKEN)return denied('session_physical_unconfirmed');
  let live;
  try{live=await inspect(db,current.attempt_id,env.WORKFLOW_GITHUB_DISPATCH_TOKEN);}
  catch{return denied('session_physical_unconfirmed');}
  if(live.state!=='running')return denied('session_physical_unconfirmed');
  let binding;
  try{binding=oldV2?await env.WEIXIN_ACTION_PROVIDER!.getBinding():
     await env.ACTIONS!.getBinding(manifest.action);}catch{return denied('weixin_binding_unconfirmed');}
  if(!binding?.ready||!Number.isSafeInteger(binding.generation)||binding.generation<1)
   return denied('weixin_binding_not_ready');
  const body=isGeneric?String((action.with.input as {text:string}).text)+canonicalSessionUrl:
    'OpenList Session Ready\n'+canonicalSessionUrl;
  if(!body.trim()||new TextEncoder().encode(body).byteLength>4096)
    return denied('invalid_weixin_text');
  const inputDigest=await digest(body);
  const identity=crypto.randomUUID();
  const admitted=await db.prepare(`INSERT OR IGNORE INTO cloudflare_action_invocations
   (run_id,step_id,invocation_id,source_attempt_id,input_digest,
    binding_generation,contract_digest,deployment_id,created_at)
   SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(
     SELECT 1 FROM runs WHERE id=? AND outcome='running')
   AND EXISTS(SELECT 1 FROM session_executions s JOIN step_attempts a
      ON a.run_id=s.run_id AND a.step_id=s.step_id
      WHERE s.run_id=? AND s.step_id=? AND s.state='ready'
       AND s.session_url=? AND a.attempt_id=? AND a.state='claimed'
       AND a.capability_id='github.action'
       AND a.repository='lirtual/github-actions'
       AND instr(a.workflow_ref,'lirtual/github-actions/.github/workflows/openlist.yml@')=1
       AND a.owner_run_id=a.candidate_run_id AND a.owner_run_attempt=a.candidate_run_attempt
       AND NOT EXISTS(SELECT 1 FROM github_action_cancellations c WHERE c.attempt_id=a.attempt_id))
   AND EXISTS(SELECT 1 FROM cloudflare_action_gate WHERE id=1 AND state='open')
   AND NOT EXISTS(SELECT 1 FROM cloudflare_action_cancellations c
      WHERE c.run_id=? AND c.step_id=?)`)
   .bind(runId,action.id,identity,current.attempt_id,inputDigest,binding.generation,
     manifest.contract_digest,version,Date.now(),runId,runId,sourceId,
     current.session_url,current.attempt_id,runId,action.id).run();
  if(admitted.meta.changes!==1){
    const raced=await existing();
    return raced?recover(env,raced):denied('cloudflare_dispatch_not_admitted');
  }
  try{
   const identityInput={invocation_id:identity,binding_generation:binding.generation,
    deployment_id:version,contract_digest:manifest.contract_digest};
   const value=oldV2?await env.WEIXIN_ACTION_PROVIDER!.sendGenericText({...identityInput,text:body}):
     await env.ACTIONS!.execute(manifest.action,{...identityInput,
       ...(newV3?{text:body}:{session_url:canonicalSessionUrl})});
   if(value.input_digest!==inputDigest)return uncertain('weixin_receipt_conflict');
   return receipt(value.status);
  }catch{return recover(env,{invocation_id:identity,source_attempt_id:current.attempt_id,
    input_digest:inputDigest,binding_generation:binding.generation,
    contract_digest:manifest.contract_digest,deployment_id:version});}
 }catch{return uncertain('cloudflare_dispatch_unconfirmed');}
}
