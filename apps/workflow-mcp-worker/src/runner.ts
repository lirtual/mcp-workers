import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { canonicalJsonString, evaluateArguments, evaluateCondition, expandedStepCost, expansionChildId, expansionSnapshotId, toolSchemaDigest } from './plan.ts';
import type { ExprCtx, Plan, Step, StepBody } from './plan.ts';
import { GITHUB_CAPABILITY_ID, HTTP_TARGET_ARGUMENT_KEYS, LIMITS, NON_EXECUTABLE_PLAN_FIELDS, NON_EXECUTABLE_STEP_FIELDS, readHttpFixture } from './capabilities.ts';
import type { Env } from './store.ts';
import { limitResult } from './store.ts';
import { dispatchOrResumeGithubAttempt,githubAsyncAwaitingExternal,githubAsyncOutcome,observeAllowListedGithubRun,GITHUB_ASYNC_WAKE_LIMIT,GITHUB_ASYNC_WAKE_TIMEOUT,readGithubAsyncFact,type GithubAsyncFact,type GithubDispatchStep } from './github-async.ts';
import { parseRegisteredInputs, REGISTERED_GITHUB_ACTION, registeredGithubPin } from './github-registry.ts';
import { CancelObserved, isCancelRequested } from './run-cancel.ts';
import { scopedPublicMcpFetch, TRUSTED_PORTAL_ENDPOINT, PRODUCTION_PORTAL_ENDPOINT, type PortalServiceToken } from './mcp-public-fetch.ts';
import { prepareFixtureRequest, sendFixture } from './http-fixture.ts';
import { beginProtectedDispatch, finishProtectedDispatch, grantRevoked, readProtectedEffect } from './protected-effect.ts';
import { COMPENSATION_ROW, compensationEffectId, type CompensationReport, type CompensationStepReport } from './saga.ts';
import { approvalStillWaiting, waitForRuntimeApproval } from './runtime-approval.ts';

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
type ExpansionTake={ok:true;serial:string}|{ok:false;error_code:string};
function snapshotItems(serial:string):unknown[]|null{
  try{
    const parsed=JSON.parse(serial) as {items?:unknown};
    return parsed&&Array.isArray(parsed.items)?parsed.items:null;
  }catch{return null;}
}
async function readExpansionSnapshot(db:Env['DB'],runId:string,stepId:string):Promise<{items:unknown[]}|null>{
  const row=await db.prepare('SELECT output FROM run_steps WHERE run_id=? AND step_id=? AND status=?')
    .bind(runId,expansionSnapshotId(stepId),'succeeded').first<{output:string|null}>();
  if(!row?.output)return null;
  const items=snapshotItems(row.output);
  return items?{items}:null;
}
async function readChildOutcome(db:Env['DB'],runId:string,stepId:string):Promise<Outcome|null>{
  const row=await db.prepare('SELECT status,output,error_code FROM run_steps WHERE run_id=? AND step_id=?')
    .bind(runId,stepId).first<{status:string;output:string|null;error_code:string|null}>();
  if(!row||!['succeeded','failed','skipped','indeterminate'].includes(row.status))return null;
  if(row.output===null)return {status:row.status as Outcome['status'],...(row.error_code?{error_code:row.error_code}:{})};
  try{return {status:row.status as Outcome['status'],output:JSON.parse(row.output),...(row.error_code?{error_code:row.error_code}:{})};}
  catch{return {status:'indeterminate',error_code:'expansion_source_invalid'};}
}
async function finishChild(db:Env['DB'],runId:string,stepId:string,outcome:Outcome):Promise<void>{
  await db.prepare("INSERT INTO run_steps(run_id,step_id,status,output,error_code,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(run_id,step_id) DO UPDATE SET status=excluded.status,output=excluded.output,error_code=excluded.error_code,updated_at=excluded.updated_at WHERE run_steps.status IN ('waiting','running','waiting_approval')")
    .bind(runId,stepId,outcome.status,outcome.output===undefined?null:JSON.stringify(outcome.output),outcome.error_code??null,now()).run();
}
async function executePublishedTemplate(env:Env,plan:Plan,body:StepBody,ctx:ExprCtx,identity:string,runId:string,versionId:string,workflowStep:WorkflowStep):Promise<Outcome>{
  // Connection and uses come only from the published template, never from the item.
  if(body.uses==='result.emit')return {status:'succeeded',output:limitResult(evaluateArguments(body.with.data,ctx))};
  if(body.uses==='mcp.call'||body.uses==='http.request'){
    const synthetic:Step={id:identity,uses:body.uses,needs:[],with:body.with};
    const args=evaluateArguments(body.with.arguments,ctx);
    if(!args||typeof args!=='object'||Array.isArray(args)||hasUnresolvedArgument(args))return {status:'failed',error_code:'step_execution_failed'};
    const storedGrant=body.uses==='mcp.call'
      ?plan.mcp_approvals?.find(grant=>grant.endpoint===body.with.endpoint&&grant.tool===body.with.tool&&grant.scope===body.with.scope&&grant.schema_digest===body.with.schema_digest)
      :plan.http_approvals?.find(grant=>grant.fixture===body.with.fixture&&grant.scope==='read'&&grant.schema_digest===body.with.schema_digest);
    const target={db:env.DB,runId,stepId:identity,versionId,grantKey:canonicalJsonString(storedGrant??{missing:true})};
    try{
      const output=body.uses==='mcp.call'
        ?await callApprovedMcp(env,plan,synthetic,args as Record<string,unknown>,target)
        :await callApprovedHttp(env,plan,synthetic,args as Record<string,unknown>,target);
      return {status:'succeeded',output};
    }catch(error){
      return closedOutcome(error);
    }
  }
  if(body.uses==='github.run'){
    const synthetic:Step={id:identity,uses:'github.run',needs:[],with:body.with};
    return runGithubStep(env,plan,synthetic,runId,workflowStep,ctx);
  }
  return {status:'failed',error_code:'unsupported_capability'};
}
async function runExpansion(env:Env,plan:Plan,s:Step,runId:string,versionId:string,workflowStep:WorkflowStep,ctx:ExprCtx):Promise<Outcome>{
  const body=s.body,expand=s.expand,db=env.DB;
  if(s.uses!=='flow.expand'||!body||!expand||!['result.emit','mcp.call','http.request','github.run'].includes(body.uses))
    return {status:'failed',error_code:'unsupported_capability'};
  if(s.needs.some(need=>ctx.steps[need]?.status!=='succeeded'))return {status:'skipped'};
  try{if(s.if!==undefined&&!evaluateCondition(s.if,ctx))return {status:'skipped'};}
  catch{return {status:'failed',error_code:'step_execution_failed'};}
  let snapshot=await readExpansionSnapshot(db,runId,s.id);
  if(!snapshot){
    const taken=await workflowStep.do('expand-snapshot-'+s.id,{retries:{limit:0,delay:'1 second'},timeout:'30 seconds'},async():Promise<ExpansionTake>=>{
      const stored=await readExpansionSnapshot(db,runId,s.id);
      if(stored)return {ok:true,serial:JSON.stringify({items:stored.items})};
      let raw:unknown;
      try{raw=evaluateArguments(expand.items,ctx);}catch{return {ok:false,error_code:'expansion_source_invalid'};}
      if(!Array.isArray(raw))return {ok:false,error_code:'expansion_source_invalid'};
      let itemSerial:string;
      try{itemSerial=JSON.stringify(raw);}catch{return {ok:false,error_code:'expansion_source_invalid'};}
      if(new TextEncoder().encode(itemSerial).byteLength>LIMITS.definitionBytes)return {ok:false,error_code:'expansion_budget_exceeded'};
      const items=JSON.parse(itemSerial) as unknown[];
      if(!Array.isArray(items)||items.length>expand.max||expandedStepCost(plan.steps,new Map([[s.id,items.length]]))>LIMITS.maxExpandedSteps)
        return {ok:false,error_code:'expansion_budget_exceeded'};
      const serial=JSON.stringify({items});
      await db.prepare("INSERT INTO run_steps(run_id,step_id,status,output,updated_at) VALUES(?,?,'succeeded',?,?) ON CONFLICT(run_id,step_id) DO NOTHING")
        .bind(runId,expansionSnapshotId(s.id),serial,now()).run();
      const winner=await readExpansionSnapshot(db,runId,s.id);
      return winner?{ok:true,serial:JSON.stringify({items:winner.items})}:{ok:false,error_code:'expansion_source_invalid'};
    }) as ExpansionTake;
    if(!taken.ok)return {status:'failed',error_code:taken.error_code};
    const items=snapshotItems(taken.serial);
    if(!items)return {status:'failed',error_code:'expansion_source_invalid'};
    snapshot={items};
  }
  const outputs:unknown[]=[];
  let failure:Outcome|null=null;
  const runChild=async(index:number,item:unknown):Promise<Outcome>=>{
    const identity=expansionChildId(s.id,index);
    const prior=await readChildOutcome(db,runId,identity);
    if(prior)return prior;
    const childCtx:ExprCtx={inputs:ctx.inputs,steps:ctx.steps,expand:{item,index}};
    if(body.uses==='github.run'){
      const outcome=await executePublishedTemplate(env,plan,body,childCtx,identity,runId,versionId,workflowStep);
      await finishChild(db,runId,identity,outcome);
      return outcome;
    }
    return await workflowStep.do('workflow-'+s.id+'-'+index,{retries:{limit:0,delay:'1 second'},timeout:'30 seconds'},async():Promise<Outcome>=>{
      const again=await readChildOutcome(db,runId,identity);
      if(again)return again;
      const claim=await db.prepare("INSERT INTO run_steps(run_id,step_id,status,updated_at) VALUES(?,?,'running',?) ON CONFLICT(run_id,step_id) DO NOTHING")
        .bind(runId,identity,now()).run();
      if(!claim.meta.changes)return (await readChildOutcome(db,runId,identity))??{status:'indeterminate',error_code:'external_outcome_unknown'};
      const outcome=await executePublishedTemplate(env,plan,body,childCtx,identity,runId,versionId,workflowStep);
      await finishChild(db,runId,identity,outcome);
      return outcome;
    }) as Outcome;
  };
  for(let offset=0;offset<snapshot.items.length&&!failure;offset+=LIMITS.maxParallel){
    const wave=snapshot.items.slice(offset,offset+LIMITS.maxParallel);
    const waveOutcomes=await Promise.all(wave.map((item,index)=>runChild(offset+index,item)));
    for(const outcome of waveOutcomes){
      outputs.push(outcome.status==='succeeded'?outcome.output:null);
      if(!failure&&(outcome.status==='failed'||outcome.status==='indeterminate'))failure=outcome;
    }
  }
  if(failure){
    for(let index=outputs.length;index<snapshot.items.length;index++){
      const identity=expansionChildId(s.id,index);
      if(await readChildOutcome(db,runId,identity))continue;
      await finishChild(db,runId,identity,{status:'skipped'});
    }
    return failure.status==='indeterminate'?failure:{status:'failed',error_code:failure.error_code??'step_execution_failed'};
  }
  return {status:'succeeded',output:outputs};
}
const now=()=>Date.now();
const CLOSED_FAILURE=new Set([
  'grant_revoked','approved_schema_changed','tool_schema_drift','readonly_tool_unconfirmed','readonly_hint_untrusted',
  'external_approval_required','portal_target_not_authorized','portal_target_not_configured','portal_auth_not_configured',
  'http_target_not_authorized','http_target_invalid','http_fixture_not_configured','http_credential_rejected',
  'target_argument_rejected','target_risk_acknowledgment_required','mcp_target_invalid','mcp_target_not_authorized',
  'invalid_arguments','approval_argument_rejected',
]);
const INDETERMINATE=new Set(['external_outcome_unknown','http_redirect_denied','mcp_redirect_denied']);
function closedOutcome(error: unknown): Outcome {
  const code=error instanceof Error?error.message:'';
  if(INDETERMINATE.has(code))return {status:'indeterminate',error_code:code};
  if(CLOSED_FAILURE.has(code))return {status:'failed',error_code:code};
  return {status:'failed',error_code:'step_execution_failed'};
}
const HTTP_TARGET_KEYS=new Set<string>(HTTP_TARGET_ARGUMENT_KEYS);
function rejectApprovalArgument(value: unknown): void {
  if(Array.isArray(value)){for(const item of value)rejectApprovalArgument(item);return;}
  if(!value||typeof value!=='object')return;
  for(const [key, child] of Object.entries(value as Record<string, unknown>)){
    if(key.toLowerCase()==='approval')throw Error('approval_argument_rejected');
    rejectApprovalArgument(child);
  }
}
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
  rejectApprovalArgument(args);
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
  rejectApprovalArgument(args);
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
  env:Env,plan:Plan,s:Step,runId:string,step:WorkflowStep,ctx:ExprCtx,
):Promise<Outcome>{
  if(plan.github_execution_approved!==true)
    return {status:'failed',error_code:'github_execution_approval_required'};
  const capability=s.with.capability;
  const registered=capability===REGISTERED_GITHUB_ACTION.id;
  if(capability!==GITHUB_CAPABILITY_ID&&!registered)
    return {status:'failed',error_code:'github_capability_not_registered'};
  let dispatchRequest:{capabilityId:'github.workflow.check'}|{capabilityId:typeof REGISTERED_GITHUB_ACTION.id;inputs:{subject:string}}
    ={capabilityId:'github.workflow.check'};
  if(registered){
    const withKeys=Object.keys(s.with);
    if(withKeys.length!==3||!withKeys.includes('capability')||!withKeys.includes('inputs')||!withKeys.includes('registry')||
       !registeredGithubPin(s.with.registry))
      return {status:'failed',error_code:'github_action_not_allow_listed'};
    if(!env.WORKFLOW_EXECUTOR_GITHUB_TOKEN)
      return {status:'failed',error_code:'github_executor_not_configured'};
    const inputs=parseRegisteredInputs(evaluateArguments(s.with.inputs,ctx));
    if(!inputs)return {status:'failed',error_code:'github_action_inputs_invalid'};
    dispatchRequest={capabilityId:REGISTERED_GITHUB_ACTION.id,inputs};
  }else if(Object.keys(s.with).some(key=>key!=='capability')||
     !env.WORKFLOW_EXECUTOR_GITHUB_TOKEN||!env.GITHUB_EXECUTOR_REPOSITORY||
     !env.GITHUB_EXECUTOR_REPOSITORY_ID||!env.GITHUB_EXECUTOR_REF||
     !env.GITHUB_EXECUTOR_AUDIENCE)
    return {status:'failed',error_code:Object.keys(s.with).some(key=>key!=='capability')
      ?'github_capability_not_registered':'github_executor_not_configured'};
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
    },async()=>{
      // Replay returns this cached value and must not dispatch again.
      if(await isCancelRequested(db,runId)) return {disposition:'continued' as const,suppressed:'cancel' as const};
      return dispatchOrResumeGithubAttempt(db,env,runId,s.id,dispatchRequest);
    }) as (GithubDispatchStep & {suppressed?:'cancel'})|undefined;
    if(opened&&'suppressed' in opened&&opened.suppressed==='cancel') throw new CancelObserved();
    if(opened?.disposition==='rejected')return {
      status:'failed',error_code:'github_dispatch_rejected_'+opened.httpStatus+'_'+opened.reason,
    };
    let fact=await read();
    if(!fact){
      if(await isCancelRequested(db,runId)) throw new CancelObserved();
      return {status:'indeterminate',error_code:'github_dispatch_unknown'};
    }
    let outcome=settle(fact);
    if(outcome)return outcome;
    if(await isCancelRequested(db,runId)) throw new CancelObserved();
    for(let i=0;i<GITHUB_ASYNC_WAKE_LIMIT&&fact&&!outcome;i++){
      if(fact.deadlineAt!==null&&now()>=fact.deadlineAt)break;
      if(await isCancelRequested(db,runId)) throw new CancelObserved();
      if(registered&&(fact.phase==='dispatch_accepted'||fact.phase==='pending')){
        await step.do('github-observe-'+s.id+'-'+i,{
          retries:{limit:0,delay:'1 second'},timeout:'45 seconds',
        },async()=>{await observeAllowListedGithubRun(db,env,runId,s.id);return 'observed';});
        fact=await read();
        if(!fact)return {status:'indeterminate',error_code:'github_dispatch_unknown'};
        outcome=settle(fact);
        if(outcome)return outcome;
      }
      try{
        await step.waitForEvent<{attemptId:string;callbackId:string}>(
          'github-receipt-'+s.id+'-'+i,
          {type:'github-receipt-'+s.id,timeout:GITHUB_ASYNC_WAKE_TIMEOUT});
      }catch{
        // Lost wake or timeout. Reconcile the stored receipt only.
      }
      fact=await read();
      if(!fact){
        if(await isCancelRequested(db,runId)) throw new CancelObserved();
        return {status:'indeterminate',error_code:'github_dispatch_unknown'};
      }
      outcome=settle(fact);
      if(outcome)return outcome;
      if(await isCancelRequested(db,runId)) throw new CancelObserved();
    }
    if(await isCancelRequested(db,runId)) throw new CancelObserved();
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

async function hydrateOutcomes(db: Env['DB'], runId: string, ctx: ExprCtx): Promise<void> {
  const rows=await db.prepare('SELECT step_id,status,output FROM run_steps WHERE run_id=?')
    .bind(runId).all<{step_id:string;status:string;output:string|null}>();
  for(const row of rows.results){
    if(row.step_id===COMPENSATION_ROW||row.step_id.includes(':')) continue;
    if(ctx.steps[row.step_id]) continue;
    let output: unknown;
    if(row.output!==null){try{output=JSON.parse(row.output);}catch{output=undefined;}}
    ctx.steps[row.step_id]={status:row.status,...(output===undefined?{}:{output})};
  }
}
async function readCompensationReport(db: Env['DB'], runId: string): Promise<CompensationReport | null> {
  const row=await db.prepare('SELECT output FROM run_steps WHERE run_id=? AND step_id=?')
    .bind(runId, COMPENSATION_ROW).first<{output:string|null}>();
  if(!row?.output) return null;
  try{
    const parsed=JSON.parse(row.output) as CompensationReport;
    return {...parsed, acid_rollback:false};
  }catch{return {acid_rollback:false, trigger:null, steps:[]};}
}
async function storeCompensationReport(db: Env['DB'], runId: string, report: CompensationReport): Promise<CompensationReport> {
  const steps=report.steps;
  const status=steps.some(item=>item.status==='indeterminate'||item.status==='uncleared')?'indeterminate'
    :steps.some(item=>item.status==='failed')?'failed':'succeeded';
  await db.prepare('INSERT INTO run_steps(run_id,step_id,status,output,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(run_id,step_id) DO NOTHING')
    .bind(runId, COMPENSATION_ROW, status, JSON.stringify({...report, acid_rollback:false}), now()).run();
  return (await readCompensationReport(db, runId))??{...report, acid_rollback:false};
}
// One pass on this runner. A published grant is required before any compensation call.
async function runSagaCompensation(
  env: Env, plan: Plan, ctx: ExprCtx, runId: string, versionId: string, workflowStep: WorkflowStep,
  trigger: 'failure' | 'cancel' | null,
): Promise<void> {
  if(!plan.saga) return;
  if(await readCompensationReport(env.DB, runId)) return;
  await hydrateOutcomes(env.DB, runId, ctx);
  const authorized=trigger!==null&&plan.saga.on.includes(trigger);
  const steps: CompensationStepReport[]=[];
  for(const step of [...plan.steps].reverse()){
    if(!step.compensate||step.uses!=='mcp.call'||step.with.scope!=='write') continue;
    const business=ctx.steps[step.id];
    const effect=await readProtectedEffect(env.DB, runId, step.id);
    const unknown=business?.status==='indeterminate'||effect?.state==='indeterminate'||effect?.state==='dispatching';
    if(unknown){
      steps.push({step_id:step.id, status:'uncleared', error_code:effect?.error_code??'external_outcome_unknown'});
      continue;
    }
    if(!authorized||business?.status!=='succeeded'||effect?.state!=='succeeded') continue;
    const action=step.compensate;
    const report=await workflowStep.do('saga-compensate-'+step.id,{retries:{limit:0,delay:'1 second'},timeout:'30 seconds'},async():Promise<CompensationStepReport>=>{
      let args: unknown;
      try{args=evaluateArguments(action.with.arguments,ctx);}
      catch{return {step_id:step.id,status:'failed',error_code:'step_execution_failed'};}
      if(!args||typeof args!=='object'||Array.isArray(args)||hasUnresolvedArgument(args))
        return {step_id:step.id,status:'failed',error_code:'invalid_arguments'};
      const storedGrant=plan.mcp_approvals?.find(grant=>grant.endpoint===action.with.endpoint&&grant.tool===action.with.tool&&grant.scope===action.with.scope&&grant.schema_digest===action.with.schema_digest);
      const target={db:env.DB,runId,stepId:compensationEffectId(step.id),versionId,grantKey:canonicalJsonString(storedGrant??{missing:true})};
      const synthetic:Step={id:compensationEffectId(step.id),uses:'mcp.call',needs:[],with:action.with};
      try{
        await callApprovedMcp(env,plan,synthetic,args as Record<string,unknown>,target);
        return {step_id:step.id,status:'succeeded'};
      }catch(error){
        const outcome=closedOutcome(error);
        if(outcome.error_code==='grant_revoked') return {step_id:step.id,status:'uncleared',error_code:'grant_revoked'};
        if(outcome.status==='indeterminate') return {step_id:step.id,status:'indeterminate',error_code:outcome.error_code??'external_outcome_unknown'};
        return {step_id:step.id,status:'failed',error_code:outcome.error_code??'step_execution_failed'};
      }
    }) as CompensationStepReport;
    steps.push(report);
  }
  if(!authorized&&steps.length===0) return;
  await storeCompensationReport(env.DB, runId, {acid_rollback:false, trigger:authorized?trigger:null, steps});
}
function gateFailure(errorCode: string): Outcome {
  return {status:errorCode==='approval_already_used'?'indeterminate':'failed',error_code:errorCode};
}
async function storedMcpOutput(db: Env['DB'], runId: string, stepId: string): Promise<Outcome | null> {
  const prior=await readProtectedEffect(db, runId, stepId);
  if(!prior)return null;
  if(prior.state==='succeeded'){
    if(prior.result===null)return {status:'indeterminate',error_code:'external_outcome_unknown'};
    try{return {status:'succeeded',output:JSON.parse(prior.result)};}
    catch{return {status:'indeterminate',error_code:'external_outcome_unknown'};}
  }
  return {status:'indeterminate',error_code:prior.error_code&&INDETERMINATE.has(prior.error_code)?prior.error_code:'external_outcome_unknown'};
}
async function runApprovalGatedStep(env: Env, plan: Plan, s: Step, runId: string, versionId: string, workflowStep: WorkflowStep, ctx: ExprCtx): Promise<Outcome> {
  if(s.needs.some(need=>ctx.steps[need]?.status!=='succeeded'))return {status:'skipped'};
  try{if(s.if!==undefined&&!evaluateCondition(s.if,ctx))return {status:'skipped'};}
  catch{return {status:'failed',error_code:'step_execution_failed'};}
  if(s.uses!=='mcp.call'||s.with.scope!=='write')return {status:'failed',error_code:'approval_not_applicable'};
  const stored=await storedMcpOutput(env.DB, runId, s.id);
  if(stored)return stored;
  const storedGrant=plan.mcp_approvals?.find(grant=>grant.endpoint===s.with.endpoint&&grant.tool===s.with.tool&&grant.scope===s.with.scope&&grant.schema_digest===s.with.schema_digest);
  const grantKey=canonicalJsonString(storedGrant??{missing:true});
  const gate=await waitForRuntimeApproval(env.DB, workflowStep, runId, s.id, versionId, grantKey, ()=>isCancelRequested(env.DB, runId));
  if(!gate.ok)return gateFailure(gate.error_code);
  const args=evaluateArguments(s.with.arguments, ctx);
  if(!args||typeof args!=='object'||Array.isArray(args)||hasUnresolvedArgument(args))
    return {status:'failed',error_code:'invalid_arguments'};
  return await workflowStep.do('workflow-'+s.id,{retries:{limit:0,delay:'1 second'},timeout:'30 seconds'},async():Promise<Outcome>=>{
    try{
      await env.DB.prepare("INSERT INTO run_steps(run_id,step_id,status,updated_at) VALUES(?,?,'running',?) ON CONFLICT(run_id,step_id) DO NOTHING")
        .bind(runId,s.id,now()).run();
      const output=await callApprovedMcp(env, plan, s, args as Record<string, unknown>, {db:env.DB,runId,stepId:s.id,versionId,grantKey});
      return {status:'succeeded',output};
    }catch(error){
      return closedOutcome(error);
    }
  }) as Outcome;
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
    // A resumed invocation must not dispatch the business DAG or cancel again.
    // Published cancel compensation still runs once; its protected effects do not replay a call.
    if(await isCancelRequested(db,id)){
      if(plan.saga?.on.includes('cancel')) await runSagaCompensation(this.env,plan,ctx,id,row.version_id,step,'cancel');
      return;
    }
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
    let openApprovals=0;
    try{
      while(pending.size){
        if(await isCancelRequested(db,id)) throw new CancelObserved();
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
                if(s.approval?.required===true&&!(await readGithubAsyncFact(db,id,s.id,now()))){
                  openApprovals++;
                  try{
                    const gate=await waitForRuntimeApproval(db,step,id,s.id,row.version_id,null,()=>isCancelRequested(db,id));
                    openApprovals--;
                    if(!gate.ok)return gateFailure(gate.error_code);
                  }catch(error){throw error;}
                }
                return await runGithubStep(this.env,plan,s,id,step,ctx);
              }catch(error){
                if(error instanceof CancelObserved||await isCancelRequested(db,id)) throw error instanceof CancelObserved?error:new CancelObserved();
                // A confirmed Attempt still inside its deadline is not an
                // unknown dispatch. Replay must resume it instead of freezing it.
                if(await githubAsyncAwaitingExternal(db,id,now()))throw error;
                if(openApprovals>0&&await approvalStillWaiting(db,id,now()))throw error;
                return {status:'indeterminate',error_code:'github_dispatch_unknown'} as Outcome;
              }
            })()
            : s.approval?.required===true
            ? await (async()=>{
              openApprovals++;
              try{
                const outcome=await runApprovalGatedStep(this.env,plan,s,id,row.version_id,step,ctx);
                openApprovals--;
                return outcome;
              }catch(error){throw error;}
            })()
            : s.uses==='flow.expand'||s.expand!==undefined
            ? await runExpansion(this.env,plan,s,id,row.version_id,step,ctx)
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
          await db.prepare("INSERT INTO run_steps(run_id,step_id,status,output,error_code,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(run_id,step_id) DO UPDATE SET status=excluded.status,output=excluded.output,error_code=excluded.error_code,updated_at=excluded.updated_at WHERE run_steps.status IN ('waiting','running','waiting_approval')")
          .bind(id,s.id,result.status,result.output===undefined?null:JSON.stringify(result.output),result.error_code??null,now()).run();
          return result;
        }));
        ready.forEach((s,i)=>{ctx.steps[s.id]=outcomes[i];pending.delete(s.id);if(outcomes[i].status==='failed')failed=true;
          if(outcomes[i].status==='indeterminate'){
            uncertain=true;uncertainCode??=outcomes[i].error_code??'external_outcome_unknown';
          }
          if((s.uses==='result.emit'||s.uses==='flow.repeat'||(s.uses==='flow.expand'&&s.body?.uses==='result.emit'))&&outcomes[i].status==='succeeded'){emitted=outcomes[i].output;hasEmitted=true;}});
      }
      if(plan.saga&&(failed||uncertain)){
        const trigger=failed&&plan.saga.on.includes('failure')?'failure':null;
        await runSagaCompensation(this.env,plan,ctx,id,row.version_id,step,trigger);
      }
      const output=limitResult(hasEmitted?emitted:ctx.steps[plan.steps.at(-1)!.id]?.output??null);
      await db.prepare("UPDATE runs SET outcome=?,result=?,error_code=?,updated_at=? WHERE id=? AND outcome='running'")
        .bind(uncertain?'indeterminate':failed?'failed':'succeeded',JSON.stringify(output),uncertain?uncertainCode:null,now(),id).run();
    }catch(error){
      // Cancellation already owns the terminal decision. Do not freeze the
      // Run or dispatch a replacement attempt when Cloudflare resumes.
      if(error instanceof CancelObserved||await isCancelRequested(db,id)){
        if(plan.saga?.on.includes('cancel')) await runSagaCompensation(this.env,plan,ctx,id,row.version_id,step,'cancel');
        return;
      }
      // A live GitHub Attempt still inside its deadline must survive an
      // isolate restart. Freezing it here would hide a later receipt.
      if(await githubAsyncAwaitingExternal(db,id,now()))throw error;
      if(openApprovals>0&&await approvalStillWaiting(db,id,now()))throw error;
      await db.prepare("UPDATE runs SET outcome='indeterminate',error_code='execution_interrupted',updated_at=? WHERE id=? AND outcome='running'").bind(now(),id).run();
      throw Error('execution_interrupted');
    }
  }
}
