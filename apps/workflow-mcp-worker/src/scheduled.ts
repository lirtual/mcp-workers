import {cronMatchesUtc, type CronTrigger} from './cron.ts';
import {WorkflowService, StateError, type Env} from './store.ts';
import type {Plan} from './plan.ts';

type PublishedCronRow={id:string;active_version_id:string;plan:string};
export type CronTickResult={checked:number;due:number;started:number;replayed:number;
  capacity_skipped:number;version_skipped:number;failed:number};

/** Cloudflare Cron is ingress only; admission and DAG execution are owned by the
 * existing WorkflowService and Cloudflare WorkflowOrchestrator, respectively.
 * No backfill/queue: an undelivered minute or exhausted capacity is skipped.
 */
export async function admitScheduledCron(env:Env,scheduledTime:number):Promise<CronTickResult>{
  if(!Number.isSafeInteger(scheduledTime)||scheduledTime<0)throw Error('invalid_scheduled_time');
  const stats:CronTickResult={checked:0,due:0,started:0,replayed:0,
    capacity_skipped:0,version_skipped:0,failed:0};
  const service=new WorkflowService(env);
  // Page by immutable Workflow identity so a >100-workflow deployment does
  // not silently miss later rows. Bound the maximum scan for Worker budgets.
  let lastId='';
  const minute=Math.floor(scheduledTime/60000);
  for(let page=0;page<10;page++){
    const {results}=await env.DB.prepare(
      "SELECT w.id,w.active_version_id,v.plan FROM workflows w "+
      "JOIN workflow_versions v ON v.id=w.active_version_id "+
      "WHERE w.state='active' AND w.id>? ORDER BY w.id LIMIT 100")
      .bind(lastId).all<PublishedCronRow>();
    if(!results.length)return stats;
    for(const row of results){
      lastId=row.id;
      stats.checked++;
      let plan:Plan;
      try{plan=JSON.parse(row.plan) as Plan;}catch{stats.failed++;continue;}
      const triggers=plan.triggers;
      if(!triggers?.length)continue;
      if(triggers.length!==1){stats.failed++;continue;}
      // Other registered Trigger kinds are not malformed Cron schedules.
      if(triggers[0].type!=='cron')continue;
      let due=false;
      try{due=cronMatchesUtc((triggers[0] as CronTrigger).schedule,scheduledTime);}
      catch{stats.failed++;continue;}
      if(!due)continue;
      stats.due++;
      try{
        const result=await service.start(row.id,{},'cron-'+minute.toString(36),row.active_version_id);
        if('idempotent_replay' in result && result.idempotent_replay)stats.replayed++;
        else stats.started++;
      }catch(error){
        if(error instanceof StateError && error.code==='run_capacity_exceeded')
          stats.capacity_skipped++;
        else if(error instanceof StateError &&
          ['workflow_not_active','published_version_changed','published_version_missing'].includes(error.code))
          stats.version_skipped++;
        else stats.failed++;
      }
    }
    if(results.length<100)return stats;
  }
  // Exactly 1,000 rows are valid; only fail if an 1,001st active row exists.
  const tail=await env.DB.prepare("SELECT id FROM workflows WHERE state='active' AND id>? ORDER BY id LIMIT 1")
    .bind(lastId).first<{id:string}>();
  if(!tail)return stats;
  throw Error('cron_scan_budget_exceeded');
}
