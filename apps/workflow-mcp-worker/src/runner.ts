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
          const result=(s.uses==='github.run'
            ? await (async()=>{
              try{
                await db.prepare("INSERT INTO run_steps(run_id,step_id,status,updated_at) VALUES(?,?,'running',?) ON CONFLICT(run_id,step_id) DO NOTHING")
                  .bind(id,s.id,now()).run();
                if(s.needs.some(n=>ctx.steps[n].status!=='succeeded'))return {status:'skipped'} as Outcome;
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
              if(s.needs.some(n=>ctx.steps[n].status!=='succeeded'))return {status:'skipped'};
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

