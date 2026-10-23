import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { canonicalJsonString, evaluateArguments, evaluateCondition, toolSchemaDigest } from './plan.ts';
import type { ExprCtx, Plan, Step } from './plan.ts';
import { HTTP_TARGET_ARGUMENT_KEYS, LIMITS, NON_EXECUTABLE_PLAN_FIELDS, NON_EXECUTABLE_STEP_FIELDS, readHttpFixture } from './capabilities.ts';
import type { Env } from './store.ts';
import { limitResult } from './store.ts';
import { dispatchOrResumeGithubAttempt,githubAsyncAwaitingExternal,githubAsyncOutcome,GITHUB_ASYNC_WAKE_LIMIT,GITHUB_ASYNC_WAKE_TIMEOUT,readGithubAsyncFact,type GithubAsyncFact,type GithubDispatchStep } from './github-async.ts';
import { scopedPublicMcpFetch, TRUSTED_PORTAL_ENDPOINT, PRODUCTION_PORTAL_ENDPOINT, type PortalServiceToken } from './mcp-public-fetch.ts';
import { prepareFixtureRequest, sendFixture } from './http-fixture.ts';
import { beginProtectedDispatch, finishProtectedDispatch, grantRevoked, readProtectedEffect } from './protected-effect.ts';

type Outcome={status:'succeeded'|'failed'|'skipped'|'indeterminate';output?:any;error_code?:string};
function blockedStep(step: Step): boolean {
  const record=step as Step & Record<string, unknown>;
  return NON_EXECUTABLE_STEP_FIELDS.some(key=>record[key]!==undefined);
}
async function runBoundedLoop(db: Env['DB'], s: Step, runId: string, step: WorkflowStep, ctx: ExprCtx): Promise<Outcome> {
  const times=s.repeat?.times;
  if(s.uses!=='flow.repeat'||!s.body||s.body.uses!=='result.emit'||typeof times!=='number'||!Number.isSafeInteger(times)||times<1||times>LIMITS.maxLoopIterations)
    return {status:'failed',error_code:'unbounded_loop'};
  if(s.needs.some(need=>ctx.steps[need]?.status!=='succeeded')) return {status:'skipped'};
  const started=Date.now();
  let output: unknown;
  let produced=false;
  for(let index=0; index<times; index++){
    if(Date.now()-started>LIMITS.maxLoopDeadlineMs) return {status:'failed',error_code:'loop_deadline_exceeded'};
    const loopCtx: ExprCtx={
      inputs: ctx.inputs,
      steps: produced?{...ctx.steps,[s.id]:{status:'succeeded',output}}:{...ctx.steps},
      loop:{index},
    };
    try{
      if(s.repeat?.until!==undefined&&evaluateCondition(s.repeat.until,loopCtx)) break;
      if(s.if!==undefined&&!evaluateCondition(s.if,loopCtx)) continue;
    }catch{return {status:'failed',error_code:'step_execution_failed'};}
    const iteration=await step.do('workflow-'+s.id+'-i'+index,{retries:{limit:0,delay:'1 second'},timeout:'30 seconds'},async():Promise<Outcome>=>{
      try{
        await db.prepare("INSERT INTO run_steps(run_id,step_id,status,updated_at) VALUES(?,?,'running',?) ON CONFLICT(run_id,step_id) DO NOTHING")
          .bind(runId,s.id,now()).run();
        return {status:'succeeded',output:limitResult(evaluateArguments(s.body?.with.data,loopCtx))};
      }catch{return {status:'failed',error_code:'step_execution_failed'};}
    }) as Outcome;
    if(iteration.status!=='succeeded') return iteration;
    output=iteration.output;
    produced=true;
  }
  return produced?{status:'succeeded',output}:{status:'skipped'};
}
const now=()=>Date.now();
const CLOSED_FAILURE=new Set([
  'grant_revoked','approved_schema_changed','tool_schema_drift','readonly_tool_unconfirmed','readonly_hint_untrusted',
  'external_approval_required','portal_target_not_authorized','portal_target_not_configured','portal_auth_not_configured',
  'http_target_not_authorized','http_target_invalid','http_fixture_not_configured','http_credential_rejected',
  'target_argument_rejected','target_risk_acknowledgment_required','mcp_target_invalid','mcp_target_not_authorized',
  'invalid_arguments',
]);
const INDETERMINATE=new Set(['external_outcome_unknown','http_redirect_denied','mcp_redirect_denied']);
function closedOutcome(error: unknown): Outcome {
  const code=error instanceof Error?error.message:'';
  if(INDETERMINATE.has(code))return {status:'indeterminate',error_code:code};
  if(CLOSED_FAILURE.has(code))return {status:'failed',error_code:code};
  return {status:'failed',error_code:'step_execution_failed'};
}
const HTTP_TARGET_KEYS=new Set<string>(HTTP_TARGET_ARGUMENT_KEYS);
function assertNoTargetArgument(value: unknown): void {
  if(Array.isArray(value)){for(const item of value)assertNoTargetArgument(item);return;}
  if(!value||typeof value!=='object')return;
  for(const [key, child] of Object.entries(value as Record<string, unknown>)){
    if(HTTP_TARGET_KEYS.has(key.toLowerCase()))throw Error('target_argument_rejected');
    assertNoTargetArgument(child);
  }
}
function containsSecret(value: unknown, secrets: readonly string[]): boolean {
  if(typeof value==='string')return secrets.some(secret=>value.includes(secret));
  if(Array.isArray(value))return value.some(item=>containsSecret(item, secrets));
  if(value&&typeof value==='object')return Object.values(value as Record<string, unknown>).some(item=>containsSecret(item, secrets));
  return false;
}
function configuredSecrets(env: Env): string[] {
  return [env.MCP_PORTAL_CLIENT_SECRET, env.MCP_PORTAL_CLIENT_ID, env.WORKFLOW_EXECUTOR_GITHUB_TOKEN, env.WEBHOOK_TRIGGER_SECRET, env.GITHUB_WEBHOOK_SECRET]
    .filter((value): value is string => typeof value==='string' && value.length>=16);
}
type EffectTarget={db: Env['DB']; runId: string; stepId: string; versionId: string; grantKey: string};
async function replayOrRefuse(target: EffectTarget): Promise<unknown | undefined> {
  const prior=await readProtectedEffect(target.db, target.runId, target.stepId);
  if(prior?.state==='succeeded'){
    if(prior.result===null)throw Error('external_outcome_unknown');
    try{return JSON.parse(prior.result);}catch{throw Error('external_outcome_unknown');}
  }
  if(prior?.state==='dispatching'){
    await finishProtectedDispatch(target.db, target.runId, target.stepId, 'indeterminate', null, 'external_outcome_unknown', now());
    throw Error('external_outcome_unknown');
  }
  if(prior)throw Error(prior.error_code&&INDETERMINATE.has(prior.error_code)?prior.error_code:'external_outcome_unknown');
  if(await grantRevoked(target.db, target.versionId, target.grantKey))throw Error('grant_revoked');
  return undefined;
}
async function dispatched<T>(target: EffectTarget, effect: ()=>Promise<T>): Promise<T> {
  if(await grantRevoked(target.db, target.versionId, target.grantKey))throw Error('grant_revoked');
  const started=await beginProtectedDispatch(target.db, target.runId, target.stepId, target.grantKey, now());
  if(!started){
    const replayed=await replayOrRefuse(target);
    if(replayed!==undefined)return replayed as T;
    throw Error('external_outcome_unknown');
  }
  try{
    const output=await effect();
    await finishProtectedDispatch(target.db, target.runId, target.stepId, 'succeeded', JSON.stringify(output), null, now());
    return output;
  }catch(error){
    const code=error instanceof Error&&INDETERMINATE.has(error.message)?error.message:'external_outcome_unknown';
    await finishProtectedDispatch(target.db, target.runId, target.stepId, 'indeterminate', null, code, now());
    throw Error(code);
  }
}
// A missing Run-input reference must not silently disappear during JSON
// serialization, changing the meaning of an approved external MCP call.
const hasUnresolvedArgument=(value:unknown):boolean=>
  value===undefined||(Array.isArray(value)?value.some(hasUnresolvedArgument):
    value!==null&&typeof value==='object'&&Object.values(value).some(hasUnresolvedArgument));
async function callApprovedMcp(env:Env,plan:Plan,step:Step,args:Record<string,unknown>,target:EffectTarget):Promise<unknown>{
  // Enforce the approved published contract before any remote call.
  if(plan.mcp_target_risks_accepted!==true)throw Error('target_risk_acknowledgment_required');
  const endpoint=step.with.endpoint,tool=step.with.tool,schema_digest=step.with.schema_digest;
  const scope=step.with.scope==='write'?'write':step.with.scope==='read'?'read':undefined;
  const grant=scope!==undefined&&plan.mcp_approvals?.some(g=>g.endpoint===endpoint&&g.tool===tool&&g.scope===scope&&g.schema_digest===schema_digest);
  if(!grant||typeof endpoint!=='string'||typeof tool!=='string'||
     typeof schema_digest!=='string'||!/^[0-9a-f]{64}$/.test(schema_digest))
    throw Error('external_approval_required');
  if(containsSecret(args, configuredSecrets(env)))throw Error('target_argument_rejected');
  const replayed=await replayOrRefuse(target);
  if(replayed!==undefined)return replayed;
  // Recompute from the pinned contract so a tampered Plan cannot replace the
  // expected schema while keeping an older authorized digest.
  if(await toolSchemaDigest(step.with.input_schema,step.with.output_schema)!==schema_digest)
    throw Error('approved_schema_changed');
  const client=new Client({name:'workflow-mcp-readonly-candidate',version:'0.1.0'});
  // Environment-scoped Portal selection cannot be changed by a Draft, a
  // Published Plan, or Run inputs. Production must explicitly select its own
  // Portal; the test Portal is never its implicit fallback.
  const chosenPortal=env.MCP_PORTAL_ENDPOINT;
  if(chosenPortal===undefined)throw Error('portal_target_not_configured');
  if(chosenPortal!==undefined){
    if(chosenPortal!==TRUSTED_PORTAL_ENDPOINT && chosenPortal!==PRODUCTION_PORTAL_ENDPOINT)
      throw Error('portal_target_not_authorized');
    if(endpoint!==chosenPortal)throw Error('portal_target_not_authorized');
  }
  if(endpoint===PRODUCTION_PORTAL_ENDPOINT && chosenPortal!==PRODUCTION_PORTAL_ENDPOINT)
    throw Error('portal_target_not_configured');
  let portalToken:PortalServiceToken|undefined;
  if(endpoint===TRUSTED_PORTAL_ENDPOINT || endpoint===PRODUCTION_PORTAL_ENDPOINT){
    // Fail closed before making a network request; never fall back to
    // unauthenticated access or pass credentials through Workflow inputs.
    if(!env.MCP_PORTAL_CLIENT_ID||!env.MCP_PORTAL_CLIENT_SECRET)
      throw Error('portal_auth_not_configured');
    portalToken={clientId:env.MCP_PORTAL_CLIENT_ID,clientSecret:env.MCP_PORTAL_CLIENT_SECRET};
  }
  const transport=new StreamableHTTPClientTransport(new URL(endpoint),{
    fetch:scopedPublicMcpFetch(endpoint,fetch,portalToken,chosenPortal??TRUSTED_PORTAL_ENDPOINT),
  });
  try{
    await client.connect(transport);
    const discovered=await client.listTools();
    const candidate=discovered.tools.find(t=>t.name===tool);
    // Tool annotations are untrusted claims, not a grant. This is a second
    // restrictive gate on top of the owner's exact publish approval.
    if(!candidate)throw Error('external_approval_required');
    if(scope==='read'){
      if(candidate.annotations?.readOnlyHint!==true||candidate.annotations?.destructiveHint===true)
        throw Error('readonly_tool_unconfirmed');
    }else if(candidate.annotations?.readOnlyHint!==false){
      // A missing or true hint is untrusted. It cannot authorize a write.
      throw Error('readonly_hint_untrusted');
    }
    if(await toolSchemaDigest(candidate.inputSchema,candidate.outputSchema)!==schema_digest)
      throw Error('tool_schema_drift');
    // Once tools/call is attempted, a thrown error, remote error, or unreadable
    // result does not prove the external tool had no side effects.
    return await dispatched(target, async()=>{
      try{
        const output=await client.callTool({name:tool,arguments:args});
        if(output.isError)throw Error('external_outcome_unknown');
        return limitResult(output);
      }catch(error){
        if(error instanceof Error&&error.message==='mcp_redirect_denied')throw error;
        throw Error('external_outcome_unknown');
      }
    });
  }finally{
    // A stateful peer's optional HTTP DELETE can hang even after tools/call
    // succeeded. Never block the durable Run result on remote teardown; the
    // trusted peer owns expiration of its unused session.
    // SDK close() releases local transport state without sending DELETE.
    await client.close().catch(()=>{});
  }
}

async function callApprovedHttp(env:Env,plan:Plan,step:Step,args:Record<string,unknown>,target:EffectTarget):Promise<unknown>{
  if(plan.mcp_target_risks_accepted!==true)throw Error('target_risk_acknowledgment_required');
  const fixture=step.with.fixture;
  const schema_digest=step.with.schema_digest;
  const approval=plan.http_approvals?.find(grant=>grant.fixture===fixture&&grant.scope==='read'&&grant.schema_digest===schema_digest);
  if(step.with.scope!=='read'||typeof fixture!=='string'||typeof schema_digest!=='string'||!approval?.endpoint)
    throw Error('external_approval_required');
  assertNoTargetArgument(args);
  if(containsSecret(args, configuredSecrets(env)))throw Error('target_argument_rejected');
  const replayed=await replayOrRefuse(target);
  if(replayed!==undefined)return replayed;
  if(await toolSchemaDigest(step.with.input_schema,step.with.output_schema)!==schema_digest)
    throw Error('approved_schema_changed');
  const configured=readHttpFixture(env);
  if(!configured)throw Error('http_fixture_not_configured');
  if(configured.fixture!==fixture||configured.endpoint!==approval.endpoint)throw Error('http_target_not_authorized');
  if(configured.schema_digest!==schema_digest)throw Error('approved_schema_changed');
  const request=prepareFixtureRequest(approval.endpoint, JSON.stringify(args));
  return dispatched(target, async()=>{
    const response=await sendFixture(request);
    if(!response.ok)throw Error('external_outcome_unknown');
    try{return limitResult(await response.json());}
    catch(error){
      if(error instanceof Error&&(error.message==='http_redirect_denied'||error.message==='result_too_large'))throw error;
      throw Error('external_outcome_unknown');
    }
  });
}

/**
 * GitHub cannot be executed by the generic 30-second step.do callback:
 * dispatch is externally observable, and waiting for a callback belongs in
 * a native Workflow waitForEvent (not inside step.do). The first durable
 * Attempt INSERT is UNIQUE(run_id,step_id), fencing replayed dispatch.
 */
async function runGithubStep(
  env:Env,plan:Plan,s:Step,runId:string,step:WorkflowStep,
):Promise<Outcome>{
  if(plan.github_execution_approved!==true)
    return {status:'failed',error_code:'github_execution_approval_required'};
  if(s.with.capability!=='github.workflow.check')
    return {status:'failed',error_code:'github_capability_not_registered'};
  if(!env.WORKFLOW_EXECUTOR_GITHUB_TOKEN||!env.GITHUB_EXECUTOR_REPOSITORY||
     !env.GITHUB_EXECUTOR_REPOSITORY_ID||!env.GITHUB_EXECUTOR_REF||
     !env.GITHUB_EXECUTOR_AUDIENCE)
    return {status:'failed',error_code:'github_executor_not_configured'};
  const db=env.DB;
  // The wake event is only a hint. Receipt JSON in D1 is the external
  // terminal result. A replay resumes the same Attempt and does not dispatch.
  const read=()=>readGithubAsyncFact(db,runId,s.id,now());
  const settle=(fact:GithubAsyncFact):Outcome|null=>{
    const outcome=githubAsyncOutcome(fact);
    if(!outcome)return null;
    if(fact.phase!=='external_terminal'||fact.receiptOutcome==='failed')return outcome;
    const raw=fact.resultJson===null?'null':fact.resultJson;
    try{
      return {status:'succeeded',output:limitResult(JSON.parse(raw))};
    }catch{
      return {status:'indeterminate',error_code:'github_callback_invalid'};
    }
  };
  try{
    const opened=await step.do('github-dispatch-'+s.id,{
      retries:{limit:0,delay:'1 second'},timeout:'45 seconds',
    },async()=>dispatchOrResumeGithubAttempt(db,env,runId,s.id)) as GithubDispatchStep|undefined;
    if(opened?.disposition==='rejected')return {
      status:'failed',error_code:'github_dispatch_rejected_'+opened.httpStatus+'_'+opened.reason,
    };
    let fact=await read();
    if(!fact)return {status:'indeterminate',error_code:'github_dispatch_unknown'};
    let outcome=settle(fact);
    if(outcome)return outcome;
    for(let i=0;i<GITHUB_ASYNC_WAKE_LIMIT&&fact&&!outcome;i++){
      if(fact.deadlineAt!==null&&now()>=fact.deadlineAt)break;
      try{
        await step.waitForEvent<{attemptId:string;callbackId:string}>(
          'github-receipt-'+s.id+'-'+i,
          {type:'github-receipt-'+s.id,timeout:GITHUB_ASYNC_WAKE_TIMEOUT});
      }catch{
        // Lost wake or timeout. Reconcile the stored receipt only.
      }
      fact=await read();
      if(!fact)return {status:'indeterminate',error_code:'github_dispatch_unknown'};
      outcome=settle(fact);
      if(outcome)return outcome;
    }
    return {status:'indeterminate',error_code:'github_callback_unconfirmed'};
  }catch(error){
    const fact=await read().catch(()=>null);
    if(fact){
      const outcome=settle(fact);
      if(outcome)return outcome;
      if(fact.phase==='dispatch_accepted'||fact.phase==='pending')throw error;
    }
    return {status:'indeterminate',error_code:'github_dispatch_unknown'};
  }
}

export class WorkflowRunner extends WorkflowEntrypoint<Env,{run_id:string}> {
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
    const parsed=JSON.parse(version.plan) as Plan & Record<string, unknown>;
    const plan=parsed;
    const ctx:ExprCtx={inputs:JSON.parse(row.inputs) as Record<string,unknown>,steps:{}};
    if(row.outcome==='queued'){
      const transition=await db.prepare("UPDATE runs SET outcome='running',updated_at=? WHERE id=? AND outcome='queued'").bind(now(),id).run();
      if(!transition.meta.changes)return;
    }
    if(NON_EXECUTABLE_PLAN_FIELDS.some(key=>parsed[key]!==undefined)){
      await db.prepare("UPDATE runs SET outcome='failed',result='null',error_code='unsupported_capability',updated_at=? WHERE id=? AND outcome='running'")
        .bind(now(),id).run();
      return;
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
          const result=blockedStep(s)?{status:'failed',error_code:'unsupported_capability'} as Outcome
            : (s.uses==='github.run'
            ? await (async()=>{
              try{
                await db.prepare("INSERT INTO run_steps(run_id,step_id,status,updated_at) VALUES(?,?,'running',?) ON CONFLICT(run_id,step_id) DO NOTHING")
                  .bind(id,s.id,now()).run();
                if(s.needs.some(n=>ctx.steps[n].status!=='succeeded'))return {status:'skipped'} as Outcome;
                if(s.if!==undefined&&!evaluateCondition(s.if,ctx))return {status:'skipped'} as Outcome;
                return await runGithubStep(this.env,plan,s,id,step);
              }catch(error){
                // A confirmed Attempt still inside its deadline is not an
                // unknown dispatch. Replay must resume it instead of freezing it.
                if(await githubAsyncAwaitingExternal(db,id,now()))throw error;
                return {status:'indeterminate',error_code:'github_dispatch_unknown'} as Outcome;
              }
            })()
            : s.uses==='flow.repeat'||s.repeat!==undefined
            ? await runBoundedLoop(db,s,id,step,ctx)
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
              if(s.uses==='mcp.call'||s.uses==='http.request'){
                const a=evaluateArguments(s.with.arguments,ctx);
                if(!a||typeof a!=='object'||Array.isArray(a)||hasUnresolvedArgument(a))
                  throw Error('invalid_arguments');
                const storedGrant=s.uses==='mcp.call'
                  ?plan.mcp_approvals?.find(grant=>grant.endpoint===s.with.endpoint&&grant.tool===s.with.tool&&grant.scope===s.with.scope&&grant.schema_digest===s.with.schema_digest)
                  :plan.http_approvals?.find(grant=>grant.fixture===s.with.fixture&&grant.scope==='read'&&grant.schema_digest===s.with.schema_digest);
                const grantKey=canonicalJsonString(storedGrant??{missing:true});
                const target={db,runId:id,stepId:s.id,versionId:row.version_id,grantKey};
                try{
                  const output=s.uses==='mcp.call'
                    ?await callApprovedMcp(this.env,plan,s,a as Record<string,unknown>,target)
                    :await callApprovedHttp(this.env,plan,s,a as Record<string,unknown>,target);
                  return {status:'succeeded' as const,output};
                }catch(error){
                  return closedOutcome(error);
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
          if((s.uses==='result.emit'||s.uses==='flow.repeat')&&outcomes[i].status==='succeeded'){emitted=outcomes[i].output;hasEmitted=true;}});
      }
      const output=limitResult(hasEmitted?emitted:ctx.steps[plan.steps.at(-1)!.id]?.output??null);
      await db.prepare("UPDATE runs SET outcome=?,result=?,error_code=?,updated_at=? WHERE id=? AND outcome='running'")
        .bind(uncertain?'indeterminate':failed?'failed':'succeeded',JSON.stringify(output),uncertain?uncertainCode:null,now(),id).run();
    }catch(error){
      // A live GitHub Attempt still inside its deadline must survive an
      // isolate restart. Freezing it here would hide a later receipt.
      if(await githubAsyncAwaitingExternal(db,id,now()))throw error;
      await db.prepare("UPDATE runs SET outcome='indeterminate',error_code='execution_interrupted',updated_at=? WHERE id=? AND outcome='running'").bind(now(),id).run();
      throw Error('execution_interrupted');
    }
  }
}
