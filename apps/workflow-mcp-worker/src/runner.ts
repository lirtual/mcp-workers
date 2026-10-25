import {watchPersistedSessions} from './github-action-session-watch.ts';
import { runPublishedGitHubActionTask } from './github-action-task.ts';
import { runPublishedGitHubActionSession } from './github-action-session.ts';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { evaluateArguments, evaluateCondition, toolSchemaDigest } from './plan.ts';
import type { Plan, Step } from './plan.ts';
import type { Env } from './store.ts';
import { limitResult } from './store.ts';
import { scopedPublicMcpFetch, PRODUCTION_PORTAL_ENDPOINT, type PortalServiceToken } from './mcp-public-fetch.ts';

type Outcome={status:'succeeded'|'failed'|'skipped'|'indeterminate';output?:any;error_code?:string};
/** Branch joins permit skipped alternatives, but no branch executing must not
 * accidentally authorize downstream Action effects (especially github.run).
 * Preserve all_succeeded for old Plans and for Steps without an explicit join.
 */
function dependenciesPermitRun(s:Step,completed:Record<string,Outcome>):boolean{
  const states=s.needs.map(id=>completed[id]?.status);
  if(s.needs_policy!=='allow_skipped')return states.every(status=>status==='succeeded');
  return states.some(status=>status==='succeeded')&&
    states.every(status=>status==='succeeded'||status==='skipped');
}
const now=()=>Date.now();
// A missing Run-input reference must not silently disappear during JSON
// serialization, changing the meaning of an approved external MCP call.
const hasUnresolvedArgument=(value:unknown):boolean=>
  value===undefined||(Array.isArray(value)?value.some(hasUnresolvedArgument):
    value!==null&&typeof value==='object'&&Object.values(value).some(hasUnresolvedArgument));
async function callApprovedReadonly(env:Env,plan:Plan,step:Step,args:Record<string,unknown>):Promise<unknown>{
  // Enforce the approved published contract before any remote call.
  if(plan.mcp_target_risks_accepted!==true)throw Error('target_risk_acknowledgment_required');
  const endpoint=step.with.endpoint,tool=step.with.tool,schema_digest=step.with.schema_digest;
  const grant=plan.mcp_approvals?.some(g=>g.endpoint===endpoint&&g.tool===tool&&g.scope==='read'&&g.schema_digest===schema_digest);
  if(!grant||step.with.scope!=='read'||typeof endpoint!=='string'||typeof tool!=='string'||
     typeof schema_digest!=='string'||!/^[0-9a-f]{64}$/.test(schema_digest))
    throw Error('external_approval_required');
  // Recompute from the pinned contract so a tampered Plan cannot replace the
  // expected schema while keeping an older authorized digest.
  if(await toolSchemaDigest(step.with.input_schema,step.with.output_schema)!==schema_digest)
    throw Error('approved_schema_changed');
  const client=new Client({name:'workflow-mcp-readonly-candidate',version:'0.1.0'});
  // Environment-scoped Portal identity cannot be changed by a Draft, a
  // Published Plan, or Run inputs. Only the production Portal is supported.
  const chosenPortal=env.MCP_PORTAL_ENDPOINT;
  if(chosenPortal===undefined)throw Error('portal_target_not_configured');
  if(chosenPortal!==PRODUCTION_PORTAL_ENDPOINT || endpoint!==PRODUCTION_PORTAL_ENDPOINT)
    throw Error('portal_target_not_authorized');
  let portalToken:PortalServiceToken|undefined;
  if(endpoint===PRODUCTION_PORTAL_ENDPOINT){
    // Fail closed before making a network request; never fall back to
    // unauthenticated access or pass credentials through Workflow inputs.
    if(!env.MCP_PORTAL_CLIENT_ID||!env.MCP_PORTAL_CLIENT_SECRET)
      throw Error('portal_auth_not_configured');
    portalToken={clientId:env.MCP_PORTAL_CLIENT_ID,clientSecret:env.MCP_PORTAL_CLIENT_SECRET};
  }
  const transport=new StreamableHTTPClientTransport(new URL(endpoint),{
    fetch:scopedPublicMcpFetch(endpoint,fetch,portalToken,PRODUCTION_PORTAL_ENDPOINT),
  });
  try{
    await client.connect(transport);
    const discovered=await client.listTools();
    const candidate=discovered.tools.find(t=>t.name===tool);
    // Tool annotations are untrusted claims, not a grant. This is a second
    // restrictive gate on top of the owner's exact publish approval.
    if(!candidate||candidate.annotations?.readOnlyHint!==true||
       candidate.annotations?.destructiveHint===true)throw Error('readonly_tool_unconfirmed');
    if(await toolSchemaDigest(candidate.inputSchema,candidate.outputSchema)!==schema_digest)
      throw Error('tool_schema_drift');
    // Once tools/call is attempted, a thrown error, remote error, or unreadable
    // result does not prove the external tool had no side effects.
    try{
      const output=await client.callTool({name:tool,arguments:args});
      if(output.isError)throw Error('remote_tool_failed');
      return limitResult(output);
    }catch{throw Error('external_outcome_unknown');}
  }finally{
    // A stateful peer's optional HTTP DELETE can hang even after tools/call
    // succeeded. Never block the durable Run result on remote teardown; the
    // trusted peer owns expiration of its unused session.
    // SDK close() releases local transport state without sending DELETE.
    await client.close().catch(()=>{});
  }
}

/** GitHub Action dispatch/terminal verification is handled by its own durable helpers. */
async function runGithubStep(
  env:Env,plan:Plan,s:Step,runId:string,step:WorkflowStep,
):Promise<Outcome>{
  if(plan.github_execution_approved!==true)
    return {status:'failed',error_code:'github_execution_approval_required'};
  // A malformed persisted Plan must never regain retired executor privileges.
  if(s.with.capability!=='github.action')
    return {status:'failed',error_code:'github_capability_not_registered'};
  return (s.with.action as {type?:unknown}|undefined)?.type==='session'
    ?runPublishedGitHubActionSession(env,plan,s,runId,step)
    :runPublishedGitHubActionTask(env,plan,s,runId,step);
}

const templateIsExternal=(step:Step)=>
  (step.with.template as {uses?:unknown}|undefined)?.uses==='mcp.call';

/** Freeze all conditions and arguments in a native checkpoint before effects.
 * MCP read children also use D1's existing run_steps primary key as a durable
 * one-shot dispatch fence: uncertain callback re-entry may NOT call the peer.
 * GitHub Actions remain excluded pending physical Attempt lifecycle proof.
 */
async function runForeachStep(
  env:Env,plan:Plan,s:Step,runId:string,step:WorkflowStep,
  ctx:{inputs:Record<string,unknown>;steps:Record<string,Outcome>},
):Promise<Outcome>{
  const db=env.DB;
  try{
    await db.prepare("INSERT INTO run_steps(run_id,step_id,status,updated_at) VALUES(?,?,'running',?) ON CONFLICT(run_id,step_id) DO NOTHING")
      .bind(runId,s.id,now()).run();
    if(!dependenciesPermitRun(s,ctx.steps))return {status:'skipped'};
    const config=s.with;
    const template=config.template as {id:string;uses:string;with:Record<string,unknown>;if?:unknown};
    if(!['result.emit','mcp.call'].includes(template?.uses)||!Number.isSafeInteger(config.max_items)||
       Number(config.max_items)<1||Number(config.max_items)>8)
      return {status:'failed',error_code:'invalid_foreach_plan'};
    const snapshot=await step.do('workflow-'+s.id+'-snapshot',
      {retries:{limit:0,delay:'1 second'},timeout:'30 seconds'},
      async()=>{
        const list=evaluateArguments(config.items,ctx);
        if(!Array.isArray(list)||list.length>Number(config.max_items))
          return {valid:false,items:[]} as const;
        const entries=list.map((value,index)=>{
          const itemCtx={...ctx,item:{value,index}};
          const selected=template.if===undefined||evaluateCondition(template.if,itemCtx);
          const evaluated=selected?evaluateArguments(
            template.uses==='mcp.call'?template.with.arguments:template.with.data,itemCtx):null;
          // Before any external dispatch, reject unresolved arguments across the
          // entire bounded array. Partial pre-dispatch validation is not enough.
          if(selected&&template.uses==='mcp.call'&&
             (!evaluated||typeof evaluated!=='object'||Array.isArray(evaluated)||
              hasUnresolvedArgument(evaluated)))throw Error('invalid_foreach_arguments');
          return {id:s.id+'_'+index+'_'+template.id,selected,
            output:evaluated===undefined?null:evaluated};
        });
        return {valid:true,items:limitResult(entries)} as const;
      });
    if(!snapshot.valid)return {status:'failed',error_code:'invalid_foreach_items'};
    if(!Array.isArray(snapshot.items)||snapshot.items.length>Number(config.max_items))
      return {status:'failed',error_code:'invalid_foreach_snapshot'};
    const collected:unknown[]=[];
    let succeeded=0;
    for(let i=0;i<snapshot.items.length;i++){
      const entry=snapshot.items[i];
      if(entry.id!==s.id+'_'+i+'_'+template.id||typeof entry.selected!=='boolean')
        return {status:'failed',error_code:'invalid_foreach_snapshot'};
      const outcome=await step.do('workflow-'+entry.id,
        {retries:{limit:0,delay:'1 second'},timeout:'30 seconds'},
        async():Promise<Outcome>=>{
          if(!entry.selected){
            await db.prepare("INSERT INTO run_steps(run_id,step_id,status,updated_at) VALUES(?,?,'running',?) ON CONFLICT(run_id,step_id) DO NOTHING")
              .bind(runId,entry.id,now()).run();
            return {status:'skipped'};
          }
          if(template.uses==='result.emit'){
            await db.prepare("INSERT INTO run_steps(run_id,step_id,status,updated_at) VALUES(?,?,'running',?) ON CONFLICT(run_id,step_id) DO NOTHING")
              .bind(runId,entry.id,now()).run();
            return {status:'succeeded',output:limitResult(entry.output)};
          }
          // Persist BEFORE calling an external peer. If a native checkpoint is
          // lost or the worker restarts mid-call, a repeated callback sees the
          // existing fence and returns indeterminate without a second call.
          // No new D1 table or at-most-once claim about the remote system.
          const fenced=await db.prepare(`INSERT INTO run_steps(run_id,step_id,status,updated_at)
            SELECT ?,?,'running',? WHERE EXISTS (
              SELECT 1 FROM runs WHERE id=? AND outcome='running'
            ) ON CONFLICT(run_id,step_id) DO NOTHING`)
            .bind(runId,entry.id,now(),runId).run();
          if(fenced.meta.changes!==1)
            return {status:'indeterminate',error_code:'foreach_dispatch_unconfirmed'};
          const child:Step={id:entry.id,uses:'mcp.call',needs:s.needs,with:template.with};
          try{
            const args=entry.output as Record<string,unknown>;
            return {status:'succeeded',output:await callApprovedReadonly(env,plan,child,args)};
          }catch(error){
            return error instanceof Error&&error.message==='external_outcome_unknown'
              ?{status:'indeterminate',error_code:'external_outcome_unknown'}
              :{status:'failed',error_code:'step_execution_failed'};
          }
        });
      await db.prepare("INSERT INTO run_steps(run_id,step_id,status,output,error_code,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(run_id,step_id) DO UPDATE SET status=excluded.status,output=excluded.output,error_code=excluded.error_code,updated_at=excluded.updated_at WHERE run_steps.status IN ('waiting','running')")
        .bind(runId,entry.id,outcome.status,outcome.output===undefined?null:JSON.stringify(outcome.output),
          outcome.error_code??null,now()).run();
      collected.push(outcome.status==='succeeded'?outcome.output:null);
      if(outcome.status==='succeeded')succeeded++;
      if(outcome.status==='indeterminate')return {status:'indeterminate',error_code:'foreach_child_indeterminate'};
      if(outcome.status==='failed')return {status:'failed',error_code:'foreach_child_failed'};
    }
    return succeeded?{status:'succeeded',output:limitResult(collected)}:{status:'skipped'};
  }catch{
    // On an MCP child, a native checkpoint/DB failure can have occurred
    // after the external request. Never classify that as confirmed failure.
    return templateIsExternal(s)
      ?{status:'indeterminate',error_code:'foreach_execution_unconfirmed'}
      :{status:'failed',error_code:'foreach_execution_failed'};
  }
}

export class WorkflowOrchestrator extends WorkflowEntrypoint<Env,{run_id:string}> {
  async run(event:WorkflowEvent<{run_id:string}>,step:WorkflowStep){
    const id=event.payload.run_id;
    const db=this.env.DB;
    const row=await db.prepare('SELECT version_id,inputs,outcome FROM runs WHERE id=?').bind(id).first<{version_id:string;inputs:string;outcome:string}>();
    if(!row)throw Error('run_missing');
    // An expired ambiguous admission is terminally uncertain. A Workflow
    // started much later must not run the abandoned queued Workflow plan.
    if(row.outcome!=='queued'&&row.outcome!=='running')return;
    const version=await db.prepare('SELECT plan FROM workflow_versions WHERE id=?').bind(row.version_id).first<{plan:string}>();
    if(!version)throw Error('version_missing');
    const plan=JSON.parse(version.plan) as Plan;
    const ctx:{inputs:Record<string,unknown>;steps:Record<string,Outcome>}={inputs:JSON.parse(row.inputs),steps:{}};
    if(row.outcome==='queued'){
      const transition=await db.prepare("UPDATE runs SET outcome='running',updated_at=? WHERE id=? AND outcome='queued'").bind(now(),id).run();
      if(!transition.meta.changes)return;
    }
    const pending=new Map(plan.steps.map(s=>[s.id,s]));
    let emitted:unknown=null;
    let hasEmitted=false;
    let failed=false;
    let uncertain=false;
    let uncertainCode:string|null=null;
    try{
      while(pending.size){
        const ready=[...pending.values()].filter(s=>s.needs.every(n=>ctx.steps[n])).slice(0,8);
        if(!ready.length)throw Error('invalid_execution_graph');
        const outcomes=await Promise.all(ready.map(async (s:Step):Promise<Outcome>=>{
          const result=(s.uses==='flow.foreach'
            ? await runForeachStep(this.env,plan,s,id,step,ctx)
            : s.uses==='github.run'
            ? await (async()=>{
              try{
                await db.prepare("INSERT INTO run_steps(run_id,step_id,status,updated_at) VALUES(?,?,'running',?) ON CONFLICT(run_id,step_id) DO NOTHING")
                  .bind(id,s.id,now()).run();
                if(!dependenciesPermitRun(s,ctx.steps))
                  return {status:'skipped'} as Outcome;
                if(s.if!==undefined&&!evaluateCondition(s.if,ctx))return {status:'skipped'} as Outcome;
                return await runGithubStep(this.env,plan,s,id,step);
              }catch{
                // Never retry an uncertain GitHub dispatch on a Workflow replay.
                return {status:'indeterminate',error_code:'github_dispatch_unknown'} as Outcome;
              }
            })()
            : await step.do('workflow-'+s.id,{retries:{limit:0,delay:'1 second'},timeout:'30 seconds'},async ():Promise<Outcome>=>{
            try{
              // Only an executing callback marks a Step running. Cached replay
              // must never replace a previously persisted terminal Step state.
              await db.prepare("INSERT INTO run_steps(run_id,step_id,status,updated_at) VALUES(?,?,'running',?) ON CONFLICT(run_id,step_id) DO NOTHING")
                .bind(id,s.id,now()).run();
              if(!dependenciesPermitRun(s,ctx.steps))
                  return {status:'skipped'};
              if(s.if!==undefined&&!evaluateCondition(s.if,ctx))return {status:'skipped'};
              // Exhaustive runtime dispatch is required even for a pinned plan
              // read from D1. Never reinterpret a future/unknown capability as
              // a successful result.emit operation.
              if(s.uses==='result.emit')
                return {status:'succeeded',output:limitResult(evaluateArguments(s.with.data,ctx))};
              if(s.uses==='mcp.call'){
                const a=evaluateArguments(s.with.arguments,ctx);
                if(!a||typeof a!=='object'||Array.isArray(a)||hasUnresolvedArgument(a))
                  throw Error('invalid_arguments');
                try{
                  return {status:'succeeded',output:await callApprovedReadonly(this.env,plan,s,a as Record<string,unknown>)};
                }catch(error){
                  if(error instanceof Error&&error.message==='external_outcome_unknown')
                    return {status:'indeterminate',error_code:'external_outcome_unknown'};
                  throw error;
                }
              }
              throw Error('unsupported_capability');
            }catch{return {status:'failed',error_code:'step_execution_failed'};}
          })) as Outcome;
          await db.prepare("INSERT INTO run_steps(run_id,step_id,status,output,error_code,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(run_id,step_id) DO UPDATE SET status=excluded.status,output=excluded.output,error_code=excluded.error_code,updated_at=excluded.updated_at WHERE run_steps.status IN ('waiting','running')")
          .bind(id,s.id,result.status,result.output===undefined?null:JSON.stringify(result.output),result.error_code??null,now()).run();
          return result;
        }));
        ready.forEach((s,i)=>{ctx.steps[s.id]=outcomes[i];pending.delete(s.id);if(outcomes[i].status==='failed')failed=true;
          if(outcomes[i].status==='indeterminate'){
            uncertain=true;uncertainCode??=outcomes[i].error_code??'external_outcome_unknown';
          }
          if(s.uses==='result.emit'&&outcomes[i].status==='succeeded'){emitted=outcomes[i].output;hasEmitted=true;}});
      }
      const output=limitResult(hasEmitted?emitted:ctx.steps[plan.steps.at(-1)!.id]?.output??null);
      await db.prepare("UPDATE runs SET outcome=?,result=?,error_code=?,updated_at=? WHERE id=? AND outcome='running'")
        .bind(uncertain?'indeterminate':failed?'failed':'succeeded',JSON.stringify(output),uncertain?uncertainCode:null,now(),id).run();
    }catch{
      await db.prepare("UPDATE runs SET outcome='indeterminate',error_code='execution_interrupted',updated_at=? WHERE id=? AND outcome='running'").bind(now(),id).run();
      throw Error('execution_interrupted');
    }finally{
      // The parent business Run can finish at Session Ready, but its GitHub
      // job is a separate physical resource. Keep THIS native Workflow
      // sleeping and reconciling until terminal evidence or the bounded
      // watch window. No external scheduler, false completion, or slot leak
      // on a successful Ready. Expiry requests normal cancellation only.
      if(plan.steps.some(s=>s.uses==='github.run'&&
         s.with.capability==='github.action'&&
         (s.with.action as {type?:unknown}|undefined)?.type==='session')){
        try{await watchPersistedSessions(this.env,id,step);}
        catch{
          // The independent Session record still holds quota, and explicit
          // workflow_status performs a verified recovery readback.
        }
      }
    }
  }
}

