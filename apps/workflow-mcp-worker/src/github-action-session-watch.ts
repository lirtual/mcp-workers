import type {WorkflowStep} from 'cloudflare:workers';
import type {Env} from './store.ts';
import {reconcilePersistedGitHubActionAttempt} from './github-action-attempt-reconcile.ts';
import {releaseVerifiedSessionSlot,releaseNeverDispatchedSessionSlot,releaseRejectedSessionSlot} from './github-action-session.ts';
import {requestGitHubActionCancellation} from './github-action-cancel.ts';

type Db=Pick<D1Database,'prepare'>;
export const SESSION_WATCH_INTERVAL_MS=5*60*1000;
export const SESSION_WATCH_MAX_CHECKS=144; // 12h: bounded for platform resources
export const SESSION_READY_GRACE_MS=5*60*1000;
export const SESSION_SETUP_GRACE_MS=30*60*1000;
type SessionRow={step_id:string;attempt_id:string|null;state:string;
 created_at:number;updated_at:number;duration_minutes:unknown};

/** Conservative elapsed-time fallback, not a replacement for GitHub's
 * job-level timeout measured from the actual GitHub job start.
 * Starts from Ready (after job start), so never stops before the selected
 * duration measured from job start. Session YAML must enforce the job timeout.
 */
export function sessionCancellationDue(
 row:Pick<SessionRow,'state'|'created_at'|'updated_at'|'duration_minutes'>,
 time:number,
):boolean{
 const duration=Number(row.duration_minutes);
 if(!Number.isSafeInteger(duration)||duration<1||duration>330)return false;
 if(!Number.isFinite(time)||!Number.isFinite(row.created_at)||!Number.isFinite(row.updated_at))return false;
 if(row.state==='ready')
  return time>=row.updated_at+duration*60_000+SESSION_READY_GRACE_MS;
 if(row.state==='queued'||row.state==='starting'||row.state==='uncertain')
  return time>=row.created_at+SESSION_SETUP_GRACE_MS;
 return false;
}

/**
 * Stay in the existing Cloudflare Workflow after the parent business result
 * is durable. It may be succeeded at Ready while its external GitHub job is
 * still executing. No second scheduler, callback-only terminal truth or
 * implicit force cancellation. Never silently free a slot on missing data.
 */
export async function watchPersistedSessions(
 env:Env,runId:string,step:WorkflowStep,
 maxChecks=SESSION_WATCH_MAX_CHECKS,
 now:()=>number=Date.now,
):Promise<'terminated'|'unverified'>{
 const token=env.WORKFLOW_GITHUB_DISPATCH_TOKEN;
 if(!token)return 'unverified';
 const db:Db=env.DB;
 for(let i=0;i<maxChecks;i++){
  const remaining=await step.do('session-watch-check-'+i,{
   retries:{limit:0,delay:'1 second'},timeout:'45 seconds',
  },async()=>{
   try{
   const sessions=(await db.prepare(`SELECT s.step_id,s.state,s.created_at,s.updated_at,
     a.attempt_id,json_extract(v.plan,'$.steps') AS unused_plan
     FROM session_executions s
     JOIN runs r ON r.id=s.run_id
     JOIN workflow_versions v ON v.id=r.version_id
     LEFT JOIN step_attempts a ON a.run_id=s.run_id AND a.step_id=s.step_id
     WHERE s.run_id=? AND s.state!='terminated'
     ORDER BY s.step_id LIMIT 4`).bind(runId).all<SessionRow & {unused_plan:string}>()).results;
   if(!sessions.length)return 0;
   for(const entry of sessions){
    if(!entry.attempt_id){
     // After the parent is terminal and the setup grace has elapsed,
     // NO registered Attempt is proof no GitHub POST could have occurred.
     // Live parents and all dispatch_unknown Attempts remain fully reserved.
     await releaseNeverDispatchedSessionSlot(
      db,runId,entry.step_id,now()-SESSION_SETUP_GRACE_MS);
     continue;
    }
    try{
     // Dispatch may have been definitively rejected and persisted, yet
     // the native Workflow interrupted before it returned through the
     // regular releaseRejectedSessionSlot call. No physical candidate
     // exists in this state: safely reclaim it before any network probe.
     if(await releaseRejectedSessionSlot(db,runId,entry.step_id))
      continue;
     await reconcilePersistedGitHubActionAttempt(db,entry.attempt_id,token);
     if(await releaseVerifiedSessionSlot(db,runId,entry.step_id)==='released')
      continue;
     // Never derive expiry authority from arbitrary HTTP input. Use the
     // immutable Published Plan's Step native duration.
     let duration:unknown;
     try{
      const saved=JSON.parse(entry.unused_plan) as Array<{
       id:string;with?:{action?:{inputs?:{duration_minutes?:unknown}}}
      }>;
      duration=saved.find(s=>s.id===entry.step_id)?.with?.action?.inputs?.duration_minutes;
     }catch{duration=undefined;}
     if(sessionCancellationDue({...entry,duration_minutes:duration},now()))
      await requestGitHubActionCancellation(db,runId,entry.step_id,token);
    }catch{
     // GitHub/D1 uncertainty never means the job ended. Retry at next wake.
    }
   }
   const active=await db.prepare(`SELECT COUNT(*) AS n FROM session_executions
    WHERE run_id=? AND state!='terminated'`).bind(runId).first<{n:number}>();
   return active?.n??0;
   }catch{
    // D1/network uncertainty must not stop the unattended watcher; the
    // physical Session retains quota until a later verified readback.
    return 1;
   }
  });
  if(remaining===0)return 'terminated';
  if(i<maxChecks-1)
   await step.sleep('session-watch-sleep-'+i,SESSION_WATCH_INTERVAL_MS);
 }
 return 'unverified'; // Slots remain allocated; workflow_status can reconcile.
}
