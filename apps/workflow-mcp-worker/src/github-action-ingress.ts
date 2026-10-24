import type {Env} from './store.ts';
import {verifyAndClaimPinnedGitHubAction,verifySignedPendingGitHubActionClaim,verifyAlreadyClaimedPinnedGitHubAction} from './github-action-oidc-claim.ts';
import {recordSignedSessionReady} from './github-action-session.ts';
import {recordSignedGitHubActionTaskResult} from './github-action-task.ts';
import {inspectPersistedGitHubActionAttempt} from './github-action-attempt-inspection.ts';
import type {jwtVerify} from 'jose';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type KeyResolver=Parameters<typeof jwtVerify>[1];
const result=(status:number,code:string)=>Response.json({result:code},{
 status,headers:{'cache-control':'no-store'},
});

/**
 * Action OIDC is separate from the existing fixed CI executor routes.
 * Its audience is a server-owned identity, never supplied by the caller.
 * A valid signature alone is never enough: Claim rechecks D1 and the
 * immutable Published Plan before its conditional owner update.
 */
export async function handleGithubActionClaimRequest(
 request:Request,env:Env,keys?:KeyResolver,
 inspect:typeof inspectPersistedGitHubActionAttempt=inspectPersistedGitHubActionAttempt,
):Promise<Response>{
 const route=new URL(request.url).pathname;
 if(route!=='/github/action/claim'&&route!=='/github/action/ready'&&
    route!=='/github/action/result')return result(404,'not_found');
 if(request.method!=='POST')return result(405,'method_not_allowed');
 if(!env.DB||!env.GITHUB_ACTION_OIDC_AUDIENCE||
    !/^workflow-github-[a-z0-9:-]{4,120}$/.test(env.GITHUB_ACTION_OIDC_AUDIENCE))
   return result(503,'action_claim_unavailable');
 const authorization=request.headers.get('authorization')||'';
 if(!authorization.startsWith('Bearer ')||authorization.length>8300)
   return result(401,'unauthorized');
 const credential=authorization.slice(7);
 if(!credential||credential.includes(' ')||credential.length>8192)
   return result(401,'unauthorized');
 const declared=Number(request.headers.get('content-length'));
 if(Number.isFinite(declared)&&declared>8192)return result(413,'too_large');
 let attemptId:string;
 let taskResult:Record<string,unknown>|undefined;
 let sessionUrl:string|undefined;
 try{
  // Read at most 8 KiB, even when Content-Length is absent or incorrect.
  // Never buffer an entire caller-controlled HTTP stream before checking it.
  const reader=request.body?.getReader();
  if(!reader)return result(400,'invalid_request');
  const chunks:Uint8Array[]=[];
  let length=0;
  try{
   while(true){
    const part=await reader.read();
    if(part.done)break;
    length+=part.value.byteLength;
    if(length>8192)return result(413,'too_large');
    chunks.push(part.value);
   }
  }finally{reader.releaseLock();}
  const bytes=new Uint8Array(length);
  let offset=0;
  for(const part of chunks){bytes.set(part,offset);offset+=part.byteLength;}
  const raw:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(!raw||typeof raw!=='object'||Array.isArray(raw))
    return result(400,'invalid_request');
  const keys=Object.keys(raw).sort().join(',');
  const allowed=route==='/github/action/result'?'attemptId,result':
    route==='/github/action/ready'&&keys==='attemptId,sessionUrl'?
      'attemptId,sessionUrl':'attemptId';
  if(keys!==allowed)return result(400,'invalid_request');
  const id=(raw as {attemptId?:unknown}).attemptId;
  if(typeof id!=='string'||!UUID.test(id))return result(400,'invalid_request');
  if(route==='/github/action/result'){
    const value=(raw as {result?:unknown}).result;
    if(!value||typeof value!=='object'||Array.isArray(value)||
       new TextEncoder().encode(JSON.stringify(value)).byteLength>4096)
      return result(400,'invalid_result');
  }
  attemptId=id;
  if(route==='/github/action/ready'&&Object.hasOwn(raw,'sessionUrl')){
    const value=(raw as {sessionUrl?:unknown}).sessionUrl;
    if(typeof value!=='string'||value.length>180||
       !/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com\/?$/.test(value))
      return result(400,'invalid_session_url');
    sessionUrl=value;
  }
  taskResult=route==='/github/action/result' ?
    (raw as {result:Record<string,unknown>}).result:undefined;
 }catch{return result(400,'invalid_request');}
 try{
  if(route==='/github/action/result'){
   const recorded=await recordSignedGitHubActionTaskResult(env.DB,attemptId,credential,
     env.GITHUB_ACTION_OIDC_AUDIENCE,taskResult!,keys);
   return recorded==='denied'?result(403,'result_denied'):result(200,recorded);
  }
  if(route==='/github/action/claim'){
   const verified=keys
    ?await verifyAndClaimPinnedGitHubAction(env.DB,attemptId,credential,env.GITHUB_ACTION_OIDC_AUDIENCE,keys)
    :await verifyAndClaimPinnedGitHubAction(env.DB,attemptId,credential,env.GITHUB_ACTION_OIDC_AUDIENCE);
   if(verified)return result(200,'claimed');
   // A lost HTTP 200 must not strand a physical job whose exact signed
   // identity already owns this Attempt. Cancellation and terminal fences
   // still apply; this does not grant or change ownership.
   const replay=keys
    ?await verifyAlreadyClaimedPinnedGitHubAction(env.DB,attemptId,credential,
      env.GITHUB_ACTION_OIDC_AUDIENCE,keys)
    :await verifyAlreadyClaimedPinnedGitHubAction(env.DB,attemptId,credential,
      env.GITHUB_ACTION_OIDC_AUDIENCE);
   if(replay)return result(200,'already_claimed');
   // GitHub may schedule the newly dispatched Job before its HTTP dispatch
   // ACK was persisted. A valid signed, reviewed pending candidate gets a
   // transient 503; unknown/invalid/cancelled identity remains denied.
   const pending=keys
    ?await verifySignedPendingGitHubActionClaim(env.DB,attemptId,credential,
      env.GITHUB_ACTION_OIDC_AUDIENCE,keys)
    :await verifySignedPendingGitHubActionClaim(env.DB,attemptId,credential,
      env.GITHUB_ACTION_OIDC_AUDIENCE);
   return pending?result(503,'claim_pending'):result(403,'claim_denied');
  }
  if(!env.WORKFLOW_GITHUB_DISPATCH_TOKEN)return result(503,'ready_unavailable');
  const ready=await recordSignedSessionReady(env.DB,attemptId,credential,
    env.GITHUB_ACTION_OIDC_AUDIENCE,env.WORKFLOW_GITHUB_DISPATCH_TOKEN,keys,inspect,sessionUrl);
  if(ready==='physical_unconfirmed')return result(503,'physical_unconfirmed');
  if(ready==='denied')return result(403,'ready_denied');
  if(ready==='ready'&&env.WORKFLOW){
   // Wake is advisory only: a lost sendEvent never loses the durable Ready.
   try{
    const origin=await env.DB.prepare(`SELECT r.instance_id,a.step_id FROM step_attempts a
      JOIN runs r ON r.id=a.run_id WHERE a.attempt_id=?`)
     .bind(attemptId).first<{instance_id:string;step_id:string}>();
    if(origin){
     const instance=await env.WORKFLOW.get(origin.instance_id);
     await instance.sendEvent?.({type:'github-session-ready-'+origin.step_id,
      payload:{attemptId}});
    }
   }catch{}
  }
  return result(200,ready);
 }catch{return result(503,'unavailable');}
}
