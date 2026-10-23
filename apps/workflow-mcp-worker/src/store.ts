import { assertChildInputs, compilePlan, PlanError, canonicalJsonString, expansionChildId, expansionSnapshotId } from './plan.ts';
import { GITHUB_TRIGGER_EVENTS, isConfiguredSecret, LIMITS, readHttpFixture, STEP_ID, TRIGGER_REPOSITORY, TRIGGER_SOURCE_ID } from './capabilities.ts';
import { recordRuntimeApproval } from './runtime-approval.ts';
import { cronEventId, cronMatches, CronError, publishedCronFacts } from './cron.ts';
import { PORTAL_ENDPOINT } from './mcp-public-fetch.ts';
import {githubAsyncViewsForRun} from './github-async.ts';
import {reconcileRunCancellation, requestAwaitedChildCancellation, REFINABLE_CANCEL_ERRORS, type RunCancellation} from './run-cancel.ts';
import {publishedSaga, publicCompensation} from './saga.ts';
import {observeInstance, shouldExpireUnconfirmedOutcome, unresolvedNativeTerminalError, OUTCOME_SETTLE_WINDOW_MS} from './instance-observation.ts';
import YAML from 'yaml';
function draftName(definition:string):string {
  if(!definition || new TextEncoder().encode(definition).byteLength>32768)throw new StateError('definition_too_large');
  try {
    const parsed=YAML.parse(definition,{uniqueKeys:true});
    if(parsed && typeof parsed==='object' && typeof parsed.name==='string' && parsed.name.trim())
      return parsed.name.slice(0,120);
  }catch{}
  return 'Untitled Draft';
}
import type { ApprovedOperation, HttpOperation, Plan, ReadonlyOperation, Step } from './plan.ts';

export type Env = {
  DB: D1Database;
  MCP_ACCESS_TOKEN: string;
  WORKFLOW: {
    create(options:{id:string;params:{run_id:string}}):Promise<unknown>;
    get(id:string):Promise<{status():Promise<{status:string}>;sendEvent?(event:{type:string;payload:unknown}):Promise<void>;terminate?:()=>Promise<void>}>;
  };
  // Enabled only through the explicit selected-Worker production release.
  // Optional, MCP-only machine identity for the pinned Cloudflare MCP Portal.
  MCP_PORTAL_CLIENT_ID?: string;
  MCP_PORTAL_CLIENT_SECRET?: string;
  // Pin all Workflow MCP instances to the single existing Portal.
  MCP_PORTAL_ENDPOINT?: string;
  // Production GitHub requires explicit opt-in and fixed OIDC/executor pins.
  WORKFLOW_EXECUTOR_GITHUB_TOKEN?: string;
  GITHUB_EXECUTOR_REPOSITORY?: string;
  GITHUB_EXECUTOR_REPOSITORY_ID?: string;
  GITHUB_EXECUTOR_REF?: string;
  GITHUB_EXECUTOR_AUDIENCE?: string;
  // Legacy isolated test fixtures can use the dedicated test branch;
  // production always selects the registered CI executor.
  GITHUB_TEST_WORKER_NAME?: string;
  GITHUB_TEST_DEDICATED_EXECUTOR?: string;
  WEBHOOK_TRIGGER_SOURCE?: string;
  WEBHOOK_TRIGGER_SECRET?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  HTTP_FIXTURE_ID?: string;
  HTTP_FIXTURE_URL?: string;
  HTTP_FIXTURE_SCHEMA_DIGEST?: string;

  // Legacy personal direct-target mode requires a separate explicit opt-in.
  // Without it, MCP must have a pinned Portal endpoint at Publish and Run.
};
export class StateError extends Error {
  code:string;
  constructor(code: string) { super(code); this.code=code; this.name='StateError'; }
}
const now=()=>Date.now();
const TERMINAL_OUTCOMES=['succeeded','failed','indeterminate','cancelled'];
function serverSecrets(env:Env):string[]{
  return [env.MCP_PORTAL_CLIENT_SECRET,env.MCP_PORTAL_CLIENT_ID,env.WORKFLOW_EXECUTOR_GITHUB_TOKEN,env.WEBHOOK_TRIGGER_SECRET,env.GITHUB_WEBHOOK_SECRET]
    .filter((value):value is string=>typeof value==='string'&&value.length>=16);
}
// A parent parked on an awaited child is not advancing work. Counting it toward
// the admission cap deadlocks the child it is waiting for.
export async function releaseWaitingRun(db:Env['DB'], runId:string):Promise<boolean>{
  const result=await db.prepare(`UPDATE runs SET outcome='running', updated_at=?
    WHERE id=? AND outcome='waiting' AND cancel_requested_at IS NULL
    AND (SELECT COUNT(*) FROM runs WHERE outcome IN ('queued','running')) < ${LIMITS.admissionCap}
    AND NOT EXISTS (
      SELECT 1 FROM runs AS child
      WHERE child.parent_run_id=? AND child.child_mode='await'
        AND child.outcome IN ('queued','running','waiting')
    )`).bind(now(),runId,runId).run();
  return result.meta.changes>0;
}
export async function resumeParkedRun(db:Env['DB'], runId:string):Promise<boolean>{
  // A parent still waiting on a non-terminal awaited child is not advancing.
  const result=await db.prepare(`UPDATE runs SET outcome='running', updated_at=?
    WHERE id=? AND outcome='waiting' AND cancel_requested_at IS NULL
    AND (SELECT COUNT(*) FROM runs WHERE outcome IN ('queued','running')) < ${LIMITS.admissionCap}
    AND NOT EXISTS (
      SELECT 1 FROM runs AS child
      WHERE child.parent_run_id=? AND child.child_mode='await'
        AND child.outcome IN ('queued','running','waiting')
    )`).bind(now(),runId,runId).run();
  return result.meta.changes>0;
}
export async function noteAwaitingParent(env:Env, runId:string):Promise<void>{
  const row=await env.DB.prepare('SELECT parent_run_id,parent_step_id,child_mode FROM runs WHERE id=?')
    .bind(runId).first<{parent_run_id:string|null;parent_step_id:string|null;child_mode:string|null}>();
  if(!row?.parent_run_id||row.child_mode!=='await'||!row.parent_step_id)return;
  const step=await env.DB.prepare('SELECT status,error_code FROM run_steps WHERE run_id=? AND step_id=?')
    .bind(row.parent_run_id,row.parent_step_id).first<{status:string;error_code:string|null}>();
  if(step?.status==='indeterminate'&&step.error_code==='child_wait_unconfirmed'){
    await env.DB.prepare(`UPDATE runs SET outcome='indeterminate', error_code='child_wait_unconfirmed', updated_at=?
      WHERE id=? AND outcome='waiting' AND cancel_requested_at IS NULL`)
      .bind(now(),row.parent_run_id).run();
    return;
  }
  try{
    const instance=await env.WORKFLOW.get(row.parent_run_id);
    if(instance.sendEvent) await instance.sendEvent({type:'child-done-'+row.parent_step_id,payload:{run_id:runId}});
  }catch{/* The parent wait reads the child row if this wake is lost. */}
}
// 32 Steps with <=64-byte IDs plus Run IDs/status/error metadata fit well
// within the remaining 16 KiB of the 64 KiB MCP response budget.
const MAX_RESULT=48*1024;
// A reserved start older than this window is no longer safe to retry.
// Preserve its identity and report uncertainty instead of holding quota forever.
const START_RECONCILE_WINDOW_MS=10*60*1000;
const safeId=(v:string)=>/^[a-zA-Z0-9_-]{1,128}$/.test(v);
function assertId(v:string){if(!safeId(v))throw new StateError('invalid_id');}
function json(value:unknown):string {
  const string=JSON.stringify(value);
  if(!string||new TextEncoder().encode(string).byteLength>64*1024)throw new StateError('payload_too_large');
  return string;
}
async function digest(s:string):Promise<string>{
  const result=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s));
  return [...new Uint8Array(result)].map(x=>x.toString(16).padStart(2,'0')).join('');
}
export function cleanError(e:unknown):string {return e instanceof StateError||e instanceof PlanError?e instanceof StateError?e.code:e.code:'internal_error';}
function cronPublication(plan:Plan){
  const trigger=plan.triggers?.find(item=>item.type==='cron');
  return trigger&&trigger.type==='cron'?{cron:publishedCronFacts(trigger.expression)}:{};
}
function publicationFacts(plan:Plan){
  const saga=publishedSaga(plan);
  return {...cronPublication(plan),...(saga?{saga}:{}),...approvalPublication(plan)};
}
function assertPublishedTriggers(plan:Plan, env:Env){
  for(const trigger of plan.triggers??[]){
    if(trigger.type==='cron')continue;
    if(trigger.type==='webhook'){
      if(!isConfiguredSecret(env.WEBHOOK_TRIGGER_SECRET)||!env.WEBHOOK_TRIGGER_SOURCE||!TRIGGER_SOURCE_ID.test(env.WEBHOOK_TRIGGER_SOURCE))
        throw new StateError('webhook_source_not_configured');
      if(trigger.source!==env.WEBHOOK_TRIGGER_SOURCE)throw new StateError('webhook_source_not_authorized');
      continue;
    }
    if(!isConfiguredSecret(env.GITHUB_WEBHOOK_SECRET)||!env.GITHUB_EXECUTOR_REPOSITORY||!TRIGGER_REPOSITORY.test(env.GITHUB_EXECUTOR_REPOSITORY))
      throw new StateError('github_event_source_not_configured');
    if(trigger.repository!==env.GITHUB_EXECUTOR_REPOSITORY)throw new StateError('github_event_source_not_authorized');
    if(trigger.events.some(event=>!(GITHUB_TRIGGER_EVENTS as readonly string[]).includes(event)))throw new StateError('unauthorized_event');
  }
}
function operationOf(step:Step):{uses:string;with:Record<string,unknown>}|undefined{
  if((step.uses==='flow.expand'||step.uses==='flow.repeat')&&step.body) return {uses:step.body.uses,with:step.body.with};
  if(step.uses==='mcp.call'||step.uses==='github.run'||step.uses==='http.request') return {uses:step.uses,with:step.with};
  return undefined;
}
function sortGrants<T>(grants:T[]):T[]{
  return grants.slice().sort((a,b)=>JSON.stringify(a)<JSON.stringify(b)?-1:JSON.stringify(a)>JSON.stringify(b)?1:0);
}
function mcpGrant(withData:Record<string,unknown>):ReadonlyOperation{
  const scope=withData.scope==='write'?'write':'read';
  return {endpoint:withData.endpoint as string,tool:withData.tool as string,scope,schema_digest:withData.schema_digest as string};
}
function mcpGrants(plan:Plan):ReadonlyOperation[]{
  return [...new Map(plan.steps.flatMap(step=>{
    const grants:ReadonlyOperation[]=[];
    const operation=operationOf(step);
    if(operation?.uses==='mcp.call') grants.push(mcpGrant(operation.with));
    if(step.compensate?.uses==='mcp.call') grants.push(mcpGrant(step.compensate.with));
    return grants.map(grant=>[JSON.stringify(grant),grant] as const);
  })).values()];
}
function httpGrants(plan:Plan, env:Env):HttpOperation[]{
  const fixture=readHttpFixture(env);
  return [...new Map(plan.steps.flatMap(step=>{
    const operation=operationOf(step);
    if(operation?.uses!=='http.request') return [];
    const grant:HttpOperation={
      fixture:operation.with.fixture as string,
      ...(fixture?{endpoint:fixture.endpoint}:{}),
      scope:'read',
      schema_digest:operation.with.schema_digest as string,
    };
    return [[JSON.stringify(grant),grant] as const];
  })).values()];
}
function externalGrants(plan:Plan, env:Env):ApprovedOperation[]{
  return sortGrants([...mcpGrants(plan), ...httpGrants(plan, env)]);
}
function publishesGithub(plan:Plan):boolean{
  return plan.steps.some(step=>operationOf(step)?.uses==='github.run');
}
function approvalGatePreview(plan:Plan){
  const binding=['run_id','step_id','published_version_id'];
  const gates=[];
  for(const step of plan.steps){
    if(step.approval?.required!==true)continue;
    const operation=operationOf(step);
    if(operation?.uses==='mcp.call'&&operation.with.scope==='write')
      gates.push({step_id:step.id,action:'mcp.call' as const,scope:'write' as const,when:'before_dispatch' as const,binding,effect:'once' as const});
    else if(operation?.uses==='github.run')
      gates.push({step_id:step.id,action:'github.run' as const,scope:'github_execution' as const,when:'before_dispatch' as const,binding,effect:'once' as const});
  }
  return gates;
}
function approvalPublication(plan:Plan){
  const approval_gates=approvalGatePreview(plan);
  return approval_gates.length?{approval_gates}:{};
}
function issueMessage(code:string, detail?:string):string{
  switch(code){
    case 'unsupported_field': return `Field "${detail}" is not supported.`;
    case 'unsupported_capability': return 'This action is not supported.';
    case 'unsupported_operation_scope': return 'This operation scope is not allowed.';
    case 'invalid_fixture': return 'The HTTP action must name the registered fixture.';
    case 'target_argument_rejected': return 'Runtime arguments cannot select a server, URL, repository, or credential.';
    case 'approval_argument_rejected': return 'Arguments cannot add or widen a runtime approval.';
    case 'invalid_approval': return 'approval.required must be true. Arguments cannot add or widen a gate.';
    case 'approval_not_applicable': return 'Only a portal write or GitHub step can declare a runtime approval. Reads do not wait.';
    case 'approved_schema_changed': return 'The pinned schema does not match the registered contract.';
    case 'unsupported_github_capability': return 'Use github.workflow.check or github.action.registered.';
    case 'resource_provider_unavailable': return 'No tsrv resource provider is registered. A GitHub job result is not Ready.';
    case 'invalid_github_inputs': return 'GitHub Action inputs do not match the allow-listed schema.';
    case 'invalid_reference':
    case 'invalid_step_reference': return 'The reference is not allowed from this step.';
    case 'invalid_yaml_or_json': return 'The definition is not valid YAML or JSON.';
    case 'invalid_endpoint': return 'The MCP endpoint is not a canonical public HTTPS URL.';
    case 'excessive_parallelism': return `More than ${LIMITS.maxParallel} steps would run at the same time.`;
    case 'unbounded_loop': return `repeat.times must be an integer from 1 to ${LIMITS.maxLoopIterations}.`;
    case 'loop_budget_exceeded': return `The loop exceeds ${LIMITS.maxLoopIterations} iterations or ${LIMITS.maxExpandedSteps} expanded steps.`;
    case 'dynamic_expansion': return 'repeat.times must be a literal integer. Use expand for an upstream output list.';
    case 'invalid_expansion': return 'expand.items must reference a needed step output, and expand.max must be a positive integer.';
    case 'expansion_budget_exceeded': return `Expansion exceeds the ${LIMITS.maxExpandedSteps} expanded-step cap, including snapshots, loops, and GitHub waits.`;
    case 'unsafe_loop_body': return 'Only result.emit can be repeated.';
    case 'loop_nesting_unsupported': return 'Nested steps and nested loops are not implemented.';
    case 'definition_too_large': return `The definition exceeds ${LIMITS.definitionBytes} bytes.`;
    case 'invalid_condition': return 'if must be a boolean or one condition operator.';
    case 'invalid_dependencies': return 'needs must name unique other steps.';
    case 'cyclic_dependencies': return 'Step dependencies contain a cycle.';
    case 'unsafe_expression': return 'This expression field is not allowed.';
    case 'invalid_step_id': return 'The step id is missing, duplicated, or not allowed.';
    case 'invalid_tool': return 'The MCP tool name is invalid.';
    case 'invalid_tool_schema': return 'MCP input_schema must be a concrete object schema.';
    case 'tool_schema_too_large': return 'The MCP tool schema exceeds 8192 bytes.';
    case 'invalid_operator': return 'The condition operator has the wrong number of arguments.';
    case 'expression_too_deep': return 'The expression is nested too deeply.';
    case 'expression_too_large': return 'The expression array is too large.';
    case 'non_finite_number': return 'Numbers must be finite.';
    case 'invalid_version': return 'version must be 1.';
    case 'invalid_name': return 'name must be a non-empty string of at most 120 characters.';
    case 'invalid_step_count': return 'steps must contain 1 to 32 steps.';
    case 'too_many_inputs': return 'inputs may contain at most 32 keys.';
    case 'invalid_inputs': return 'inputs must be an object.';
    case 'invalid_step': return 'Each step must be an object.';
    case 'invalid_step_arguments': return 'with must be an object, and mcp.call arguments must be an object.';
    case 'invalid_trigger': return 'triggers may declare one webhook, one GitHub event, and one cron.';
    case 'invalid_cron': return 'The cron expression is not a supported five-field UTC schedule.';
    case 'duplicate_trigger': return 'Each trigger id and type can be declared once.';
    case 'invalid_trigger_source': return 'Webhook source must be the configured source id.';
    case 'invalid_trigger_event': return 'The trigger event name is not allowed.';
    case 'invalid_repository': return 'GitHub repository must be owner/name.';
    case 'unsupported_github_event': return 'This GitHub event cannot start a business Run.';
    case 'invalid_child_workflow': return 'workflow.call needs a published workflow id, and detach must be boolean.';
    case 'child_input_rejected': return 'Child inputs must match the child declaration and cannot carry a credential or connection.';
    case 'invalid_definition': return 'The definition must be an object.';
    case 'invalid_expression': return 'The expression must be an object.';
    case 'invalid_argument_key': return 'This object key is not allowed.';
    case 'definition_too_deep': return 'The definition is nested too deeply.';
    case 'invalid_saga': return 'saga.on must list failure, cancel, or both.';
    case 'invalid_compensation': return 'compensate must name a tool, scope, arguments, and input_schema.';
    case 'compensation_policy_required': return 'compensate requires saga.on.';
    case 'compensation_not_controlled': return 'Only a controlled portal call can declare compensate.';
    default: return 'The definition is invalid.';
  }
}
function safeSuggestion(suggestion?:string):string|undefined{
  if(!suggestion)return undefined;
  if(/\b(shell|secret|token|password)\b/i.test(suggestion)||/skip/i.test(suggestion))return undefined;
  return suggestion;
}
function validationIssue(error:PlanError){
  const code=error.message.split(':')[0]??'invalid_definition';
  const detail=error.message.startsWith(code+':')?error.message.slice(code.length+1):undefined;
  const suggestion=safeSuggestion(error.suggestion);
  return {code, message:issueMessage(code, detail), ...(error.path?{path:error.path}:{}), ...(suggestion?{suggestion}:{})};
}
async function compileValidation(source:string, env:Env){
  try{
    const {digest,plan}=await compilePlan(source);
    const fixture=readHttpFixture(env);
    const http=httpGrants(plan, env);
    if(fixture && http.some(grant=>grant.schema_digest!==fixture.schema_digest))
      return {valid:false as const, issues:[{code:'approved_schema_changed', path:'/steps', message:issueMessage('approved_schema_changed'), suggestion:'Use the registered fixture schema.'}]};
    const required_approvals=externalGrants(plan, env);
    const saga=publishedSaga(plan);
    return {valid:true as const,digest,steps:plan.steps.length,issues:[] as [],
      ...(plan.expansion?{expansion:plan.expansion}:{}),
      ...(required_approvals.length?{required_approvals}:{}),
      ...(saga?{saga}:{}),
      ...approvalPublication(plan),
      ...(publishesGithub(plan)?{requires_heavy_execution_approval:true as const}:{})};
  }catch(error){
    if(!(error instanceof PlanError))throw error;
    return {valid:false as const,issues:[validationIssue(error)]};
  }
}
export function limitResult<T>(value:T,maxBytes=MAX_RESULT):T {if(new TextEncoder().encode(JSON.stringify(value)).byteLength>maxBytes)throw new StateError('result_too_large');return value;}
export function applyStatus(native:string, outcome:string):string {
  if(['succeeded','failed','indeterminate','cancelled'].includes(outcome))return outcome;
  if(native==='waiting')return 'waiting';
  // Native failure alone is not a durable business failure. Reconcile D1 first.
  // Workflows may report platform completion before D1's business outcome is
  // visible to this request. Do not prematurely freeze a still-settling Run.
  if(native==='complete')return outcome;
  return outcome;
}
type WorkflowRow={id:string;name:string;draft:string;draft_revision:number;active_version_id:string|null;state:string};
type VersionRow={id:string;plan:string;digest:string};
type RunRow={id:string;workflow_id:string;version_id:string;instance_id:string;request_digest:string;start_state:string;outcome:string;result:string|null;error_code:string|null;inputs:string;created_at:number;updated_at:number;native_complete_seen_at:number|null;cancel_requested_at:number|null};
const workflowView=(row:WorkflowRow)=>({workflow_id:row.id,name:row.name,draft_revision:row.draft_revision,definition:row.draft,published_version_id:row.active_version_id,state:row.state});
export class WorkflowService {
  private env:Env;
  constructor(env:Env){this.env=env;}
  private get db(){return this.env.DB;}
  async list(){const out=await this.db.prepare('SELECT * FROM workflows ORDER BY updated_at DESC LIMIT 100').all<WorkflowRow>();
    const scan=await this.db.prepare("SELECT COUNT(*) AS n FROM workflows WHERE state IN ('active','paused') AND active_version_id IS NOT NULL").first<{n:number}>();
    return {workflows:out.results.map(r=>({workflow_id:r.id,name:r.name,draft_revision:r.draft_revision,published_version_id:r.active_version_id,state:r.state})),scan_truncated:(scan?.n??0)>=100};}
  async get(workflow_id:string){assertId(workflow_id);const row=await this.row(workflow_id);return workflowView(row);}
  private async row(id:string){const row=await this.db.prepare('SELECT * FROM workflows WHERE id=?').bind(id).first<WorkflowRow>();if(!row)throw new StateError('workflow_not_found');return row;}
  async create(definition:string){
    const name=draftName(definition);
    const id=crypto.randomUUID(),time=now();
    await this.db.prepare('INSERT INTO workflows(id,name,draft,draft_revision,state,created_at,updated_at) VALUES(?,?,?,1,\'draft\',?,?)').bind(id,name,definition,time,time).run();
    return {workflow_id:id,draft_revision:1,state:'draft'};
  }
  async update(workflow_id:string,expected_revision:number,definition:string){
    assertId(workflow_id);if(!Number.isSafeInteger(expected_revision)||expected_revision<1)throw new StateError('invalid_revision');
    const name=draftName(definition);
    const x=await this.db.prepare('UPDATE workflows SET draft=?,name=?,draft_revision=draft_revision+1,updated_at=? WHERE id=? AND draft_revision=?').bind(definition,name,now(),workflow_id,expected_revision).run();
    if(!x.meta.changes) {await this.row(workflow_id);throw new StateError('revision_conflict');}
    return {workflow_id,draft_revision:expected_revision+1};
  }
  async validate(workflow_id:string,revision:number){
    assertId(workflow_id);const row=await this.row(workflow_id);
    if(row.draft_revision!==revision)throw new StateError('revision_conflict');
    return compileValidation(row.draft, this.env);
  }
  async validateDefinition(definition:string){
    return compileValidation(definition, this.env);
  }
  async publish(workflow_id:string,expected_revision:number,approved_operations:ApprovedOperation[]=[],accept_target_risks=false,approve_heavy_execution=false){
    assertId(workflow_id);const row=await this.row(workflow_id);
    if(row.draft_revision!==expected_revision)throw new StateError('revision_conflict');
    let plan: Plan;
    let plan_digest: string;
    try {
      const compiled=await compilePlan(row.draft);
      plan=compiled.plan;
      plan_digest=compiled.digest;
    } catch(error) {
      if(error instanceof PlanError && error.message.split(':')[0]==='resource_provider_unavailable')
        throw new StateError('resource_provider_unavailable');
      throw error;
    }
    // The owner must explicitly approve the exact immutable URL + tool + scope.
    // Publishing an arbitrary Draft is not itself an external-operation grant.
    const mcp=sortGrants(mcpGrants(plan));
    const http=sortGrants(httpGrants(plan,this.env));
    const required=externalGrants(plan,this.env);
    const provided=sortGrants(approved_operations);
    if(http.length && !readHttpFixture(this.env))throw new StateError('http_fixture_not_configured');
    if(JSON.stringify(required)!==JSON.stringify(provided))throw new StateError('external_approval_required');
    if(mcp.length){
      const portal=this.env.MCP_PORTAL_ENDPOINT;
      if(portal===undefined)throw new StateError('portal_target_not_configured');
      if(![PORTAL_ENDPOINT].includes(portal) ||
         mcp.some(grant=>grant.endpoint!==portal))throw new StateError('portal_target_not_authorized');
    }
    const fixture=readHttpFixture(this.env);
    if(http.length){
      if(!fixture)throw new StateError('http_fixture_not_configured');
      if(http.some(grant=>grant.fixture!==fixture.fixture || grant.endpoint!==fixture.endpoint))
        throw new StateError('http_target_not_authorized');
      if(http.some(grant=>grant.schema_digest!==fixture.schema_digest))
        throw new StateError('approved_schema_changed');
    }
    // Personal trusted-target mode: a separate explicit risk acknowledgement
    // is required at each Publish in addition to exact per-operation grants.
    // This is an authenticated API assertion, not proof of human interaction.
    if(required.length && accept_target_risks!==true)throw new StateError('target_risk_acknowledgment_required');
    const hasGithub=publishesGithub(plan);
    if(hasGithub && approve_heavy_execution!==true)throw new StateError('github_execution_approval_required');
    assertPublishedTriggers(plan,this.env);
    const httpApprovals=http.flatMap(grant=>grant.endpoint?[{...grant, endpoint:grant.endpoint}]:[]);
    const scopedPlan:Plan=required.length?{
      ...plan,
      ...(mcp.length?{mcp_approvals:mcp}:{}),
      ...(httpApprovals.length?{http_approvals:httpApprovals}:{}),
      mcp_target_risks_accepted:true,
    }:plan;
    const publishedPlan:Plan=hasGithub?{...scopedPlan,github_execution_approved:true}:scopedPlan;
    // Repeated Publish of an unchanged Draft resolves to its existing Version.
    if(row.active_version_id){
      const current=await this.db.prepare('SELECT digest FROM workflow_versions WHERE id=? AND workflow_id=?').bind(row.active_version_id,workflow_id).first<{digest:string}>();
      if(current?.digest===plan_digest)return {workflow_id,published_version_id:row.active_version_id,digest:plan_digest,state:row.state,...publicationFacts(plan)};
    }
    const version=crypto.randomUUID(),t=now();
    const batch=await this.db.batch([
      this.db.prepare('UPDATE workflows SET active_version_id=?,state=CASE WHEN state=\'paused\' THEN \'paused\' ELSE \'active\' END,updated_at=? WHERE id=? AND draft_revision=? AND active_version_id IS ?').bind(version,t,workflow_id,expected_revision,row.active_version_id),
      this.db.prepare('INSERT INTO workflow_versions(id,workflow_id,digest,plan,created_at) SELECT ?,id,?,?,? FROM workflows WHERE id=? AND active_version_id=?').bind(version,plan_digest,json(publishedPlan),t,workflow_id,version),
    ]);
    if(!batch[0].meta.changes||!batch[1].meta.changes){
      // A concurrent identical Publish can win the CAS; never report a second version.
      const latest=await this.row(workflow_id);
      if(latest.draft_revision===expected_revision&&latest.active_version_id){
        const current=await this.db.prepare('SELECT digest FROM workflow_versions WHERE id=? AND workflow_id=?').bind(latest.active_version_id,workflow_id).first<{digest:string}>();
        if(current?.digest===plan_digest)return {workflow_id,published_version_id:latest.active_version_id,digest:plan_digest,state:latest.state,...publicationFacts(plan)};
      }
      throw new StateError('revision_conflict');
    }
    return {workflow_id,published_version_id:version,digest:plan_digest,state:row.state==='paused'?'paused':'active',...publicationFacts(publishedPlan)};
  }
  async approve(run_id:string, step_id:string, published_version_id:string, decision:'approve'|'deny'){
    assertId(run_id);assertId(published_version_id);
    if(!STEP_ID.test(step_id))throw new StateError('invalid_step_id');
    const run=await this.db.prepare('SELECT version_id,instance_id FROM runs WHERE id=?')
      .bind(run_id).first<{version_id:string;instance_id:string}>();
    if(!run)throw new StateError('run_not_found');
    if(run.version_id!==published_version_id)throw new StateError('approval_binding_mismatch');
    const version=await this.db.prepare('SELECT plan FROM workflow_versions WHERE id=?')
      .bind(published_version_id).first<{plan:string}>();
    if(!version)throw new StateError('version_missing');
    const plan=JSON.parse(version.plan) as Plan;
    const step=plan.steps.find(item=>item.id===step_id);
    if(step?.approval?.required!==true)throw new StateError('approval_not_required');
    const gate=await this.db.prepare('SELECT version_id, deadline_at FROM runtime_approval_gates WHERE run_id=? AND step_id=?')
      .bind(run_id, step_id).first<{version_id:string;deadline_at:number}>();
    if(!gate||gate.deadline_at<=now())throw new StateError('approval_not_open');
    if(gate.version_id!==published_version_id)throw new StateError('approval_binding_mismatch');
    const stored=decision==='approve'?'approved':'denied';
    let recorded:{decision:'approved'|'denied';consumed:boolean;conflict:boolean};
    try{recorded=await recordRuntimeApproval(this.db,run_id,step_id,published_version_id,stored,now());}
    catch{throw new StateError('approval_binding_mismatch');}
    if(recorded.conflict)throw new StateError('approval_conflict');
    // The row is the decision. The wake payload cannot authorize a dispatch.
    try{
      const instance=await this.env.WORKFLOW.get(run.instance_id);
      if(instance.sendEvent)await instance.sendEvent({type:'approval-'+step_id,payload:{run_id,step_id,published_version_id}});
    }catch{/* A later wake reads the same row. */}
    return {run_id,step_id,published_version_id,decision:recorded.decision,consumed:recorded.consumed,human_presence:false as const};
  }
  async cronTickTargets(utcMs:number){
    const pageSize=100;
    const targets:{workflow_id:string;state:string}[]=[];
    let after='';
    for(let page=0;page<100;page++){
      const rows=await this.db.prepare(`SELECT w.id AS id, w.state AS state, v.plan AS plan
        FROM workflows w JOIN workflow_versions v ON v.id=w.active_version_id AND v.workflow_id=w.id
        WHERE w.state IN ('active','paused') AND w.active_version_id IS NOT NULL AND w.id>?
        ORDER BY w.id ASC LIMIT ${pageSize}`).bind(after).all<{id:string;state:string;plan:string}>();
      for(const row of rows.results){
        try{
          const plan=JSON.parse(row.plan) as Plan;
          const trigger=plan.triggers?.find(item=>item.type==='cron');
          if(!trigger||trigger.type!=='cron'||!cronMatches(trigger.expression,utcMs))continue;
          targets.push({workflow_id:row.id,state:row.state});
        }catch(error){
          if(error instanceof CronError||error instanceof SyntaxError)targets.push({workflow_id:row.id,state:'invalid'});
          else throw error;
        }
      }
      if(rows.results.length<pageSize)return {truncated:false,targets};
      after=rows.results[rows.results.length-1]?.id??after;
    }
    return {truncated:true,targets};
  }
  async dueCronTargets(){
    const rows=await this.db.prepare(`SELECT d.workflow_id AS workflow_id, d.scheduled_ms AS scheduled_ms, w.state AS state
      FROM cron_due d JOIN workflows w ON w.id=d.workflow_id
      ORDER BY d.scheduled_ms ASC, d.workflow_id ASC LIMIT 100`).all<{workflow_id:string;scheduled_ms:number;state:string}>();
    return rows.results;
  }
  async expireCronDue(){
    await this.db.prepare('DELETE FROM cron_due WHERE created_at<=?').bind(now()-24*60*60_000).run();
  }
  async reconcileCancellation(runId:string){
    return reconcileRunCancellation(this.db,this.env,runId);
  }
  async overdueCancellationTargets(limit=100){
    const refinable=[...REFINABLE_CANCEL_ERRORS];
    const rows=await this.db.prepare(`SELECT id FROM runs WHERE cancel_requested_at IS NOT NULL
      AND cancel_requested_at<=? AND (
        outcome IN ('queued','running','waiting') OR
        (outcome='indeterminate' AND error_code IN (${refinable.map(()=>'?').join(',')}))
      ) ORDER BY updated_at ASC,cancel_requested_at ASC,id ASC LIMIT ?`)
      .bind(now()-10*60_000,...refinable,limit).all<{id:string}>();
    return rows.results;
  }
  async rememberCronDue(workflowId:string, scheduledMs:number, eventId:string){
    const stamp=now();
    await this.db.prepare('DELETE FROM cron_due WHERE created_at<=?').bind(stamp-24*60*60_000).run();
    await this.db.prepare(`INSERT OR IGNORE INTO cron_due(workflow_id,event_id,scheduled_ms,created_at)
      SELECT ?,?,?,? WHERE (SELECT COUNT(*) FROM cron_due)<10000`)
      .bind(workflowId, eventId, scheduledMs, stamp).run();
    const present=await this.db.prepare('SELECT 1 AS present FROM cron_due WHERE workflow_id=? AND event_id=?')
      .bind(workflowId,eventId).first<{present:number}>();
    if(!present)throw new StateError('cron_due_capacity_exceeded');
  }
  async clearCronDue(workflowId:string, eventId:string){
    await this.db.prepare('DELETE FROM cron_due WHERE workflow_id=? AND event_id=?').bind(workflowId, eventId).run();
  }
  async revoke(workflow_id:string, published_version_id:string, operation:ApprovedOperation){
    assertId(workflow_id);assertId(published_version_id);
    const version=await this.db.prepare('SELECT plan FROM workflow_versions WHERE id=? AND workflow_id=?')
      .bind(published_version_id, workflow_id).first<{plan:string}>();
    if(!version)throw new StateError('version_missing');
    const plan=JSON.parse(version.plan) as Plan;
    const provided=canonicalJsonString(operation);
    const approvals=[...(plan.mcp_approvals??[]), ...(plan.http_approvals??[])];
    if(!approvals.some(grant=>canonicalJsonString(grant)===provided))throw new StateError('grant_not_found');
    await this.db.prepare('INSERT OR IGNORE INTO grant_revocations(workflow_id,version_id,grant_key,revoked_at) VALUES(?,?,?,?)')
      .bind(workflow_id, published_version_id, provided, now()).run();
    return {workflow_id, published_version_id, revoked:true as const};
  }
  async admitEvent(workflow_id:string,admission:{kind:'webhook'|'github_event'|'cron';event:string;event_id:string|null;source:string;payload:Record<string,unknown>}){
    assertId(workflow_id);
    const inputs={event:admission.event,event_id:admission.event_id,payload:admission.payload};
    const key=admission.event_id===null?undefined:'evt_'+await digest(admission.kind+'\0'+admission.event_id);
    if(key){
      const existing=await this.db.prepare('SELECT id FROM runs WHERE workflow_id=? AND admission_key=?').bind(workflow_id,key).first<{id:string}>();
      if(existing)return {...await this.start(workflow_id,inputs,key,'event'),dedupe:'stable_event_id' as const,exactly_once:false as const};
    }
    const triggerVersion=await this.assertActiveTrigger(workflow_id,admission);
    const admitted=await this.start(workflow_id,inputs,key,'event',triggerVersion);
    return {...admitted,dedupe:key?'stable_event_id' as const:'not_claimed' as const,exactly_once:false as const};
  }
  private async assertActiveTrigger(workflow_id:string,admission:{kind:'webhook'|'github_event'|'cron';event:string;source:string;event_id:string|null;payload:Record<string,unknown>}):Promise<string>{
    const wf=await this.row(workflow_id);
    if(wf.state!=='active'||!wf.active_version_id)throw new StateError('workflow_not_active');
    const version=await this.db.prepare('SELECT plan FROM workflow_versions WHERE id=? AND workflow_id=?').bind(wf.active_version_id,workflow_id).first<{plan:string}>();
    if(!version)throw new StateError('version_missing');
    const plan=JSON.parse(version.plan) as Plan;
    const trigger=(plan.triggers??[]).find(item=>item.type===admission.kind);
    if(!trigger)throw new StateError('unauthorized_source');
    if(trigger.type==='cron'){
      if(admission.source!=='worker-scheduled'||admission.event!=='cron')throw new StateError('unauthorized_source');
      if(typeof admission.payload.scheduled_time!=='string')throw new StateError('invalid_input');
      const scheduled=Date.parse(admission.payload.scheduled_time);
      if(!Number.isSafeInteger(scheduled)||cronEventId(scheduled)!==admission.event_id)throw new StateError('invalid_event_id');
      if(!cronMatches(trigger.expression,scheduled))throw new StateError('unauthorized_event');
      return wf.active_version_id;
    }
    if(trigger.type==='webhook'){
      if(trigger.source!==this.env.WEBHOOK_TRIGGER_SOURCE||admission.source!==trigger.source)throw new StateError('unauthorized_source');
      if(trigger.event!==admission.event)throw new StateError('unauthorized_event');
      return wf.active_version_id;
    }
    if(trigger.repository!==this.env.GITHUB_EXECUTOR_REPOSITORY||admission.source!==trigger.repository)throw new StateError('unauthorized_source');
    if(!(GITHUB_TRIGGER_EVENTS as readonly string[]).includes(admission.event)||!trigger.events.includes(admission.event))throw new StateError('unauthorized_event');
    return wf.active_version_id;
  }
  async cancel(run_id:string){
    assertId(run_id);
    const existing=await this.db.prepare('SELECT id,cancel_requested_at FROM runs WHERE id=?').bind(run_id).first<{id:string;cancel_requested_at:number|null}>();
    if(!existing)throw new StateError('run_not_found');
    if(existing.cancel_requested_at==null){
      await this.db.prepare('UPDATE runs SET cancel_requested_at=?,updated_at=? WHERE id=? AND cancel_requested_at IS NULL').bind(now(),now(),run_id).run();
    }
    // Detached children are not owned by this request and keep running.
    await requestAwaitedChildCancellation(this.db,run_id);
    return this.status(run_id);
  }
  async reconcileAwaitedChildStarts(parent_run_id:string){
    const rows=await this.db.prepare(`SELECT * FROM runs WHERE parent_run_id=? AND child_mode='await'
      AND outcome IN ('queued','running','waiting') AND start_state IN ('reserved','start_unknown')
      ORDER BY created_at ASC,id ASC LIMIT 8`).bind(parent_run_id).all<RunRow>();
    for(const child of rows.results)await this.reconcileStart(child);
  }
  async pause(workflow_id:string){assertId(workflow_id);const results=await this.db.batch([
    this.db.prepare("UPDATE workflows SET state='paused',updated_at=? WHERE id=? AND state='active'").bind(now(),workflow_id),
    this.db.prepare('DELETE FROM cron_due WHERE workflow_id=?').bind(workflow_id),
  ]);if(!results[0]?.meta?.changes)throw new StateError('not_active');return {workflow_id,state:'paused'};}
  async resume(workflow_id:string){assertId(workflow_id);const x=await this.db.prepare("UPDATE workflows SET state='active',updated_at=? WHERE id=? AND state='paused' AND active_version_id IS NOT NULL").bind(now(),workflow_id).run();if(!x.meta.changes)throw new StateError('not_paused');return {workflow_id,state:'active'};}
  async admitChild(args:{parent_run_id:string;parent_step_id:string;workflow_id:string;inputs:Record<string,unknown>;mode:'await'|'detach'}){
    assertId(args.parent_run_id);assertId(args.workflow_id);
    if(!STEP_ID.test(args.parent_step_id))throw new StateError('invalid_id');
    const parent=await this.db.prepare('SELECT outcome,call_depth,cancel_requested_at FROM runs WHERE id=?')
      .bind(args.parent_run_id).first<{outcome:string;call_depth:number|null;cancel_requested_at:number|null}>();
    if(!parent)throw new StateError('run_not_found');
    if(parent.cancel_requested_at!=null)throw new StateError('cancel_requested');
    const depth=Number(parent.call_depth??0)+1;
    if(!Number.isSafeInteger(depth)||depth>LIMITS.maxChildDepth)throw new StateError('child_depth_exceeded');
    const inputJson=json(args.inputs);
    const request_digest=await digest(canonicalJsonString(args.inputs));
    const key='child_'+await digest(args.parent_run_id+'\0'+args.parent_step_id+'\0'+args.mode);
    // The child row is the durable admission record. Recover it before looking
    // at mutable publication state so a replay survives pause or republish.
    const existing=await this.db.prepare('SELECT * FROM runs WHERE workflow_id=? AND admission_key=?')
      .bind(args.workflow_id,key).first<RunRow>();
    if(existing){
      if(existing.request_digest!==request_digest)throw new StateError('idempotency_conflict');
      if(args.mode==='await'&&!TERMINAL_OUTCOMES.includes(existing.outcome))
        await this.db.prepare("UPDATE runs SET outcome='waiting',updated_at=? WHERE id=? AND outcome='running' AND cancel_requested_at IS NULL")
          .bind(now(),args.parent_run_id).run();
      return this.reconcileStart(existing);
    }
    const wf=await this.row(args.workflow_id);
    if(wf.state!=='active'||!wf.active_version_id)throw new StateError('workflow_not_active');
    const versionRow=await this.db.prepare('SELECT plan FROM workflow_versions WHERE id=? AND workflow_id=?')
      .bind(wf.active_version_id,args.workflow_id).first<{plan:string}>();
    if(!versionRow)throw new StateError('version_missing');
    let childPlan:Plan;
    try{childPlan=JSON.parse(versionRow.plan) as Plan;}
    catch{throw new StateError('child_plan_unreadable');}
    try{assertChildInputs(childPlan.inputs,args.inputs,serverSecrets(this.env));}
    catch(error){
      if(error instanceof PlanError)throw new StateError(error.message.split(':')[0]||'child_input_rejected');
      throw error;
    }
    if(args.mode==='await'){
      if(parent.outcome!=='running'&&parent.outcome!=='waiting')throw new StateError('parent_not_running');
      if(parent.outcome==='running'){
        const parked=await this.db.prepare("UPDATE runs SET outcome='waiting',updated_at=? WHERE id=? AND outcome='running' AND cancel_requested_at IS NULL")
          .bind(now(),args.parent_run_id).run();
        if(!parked.meta.changes)throw new StateError('parent_not_running');
      }
    }
    const version=wf.active_version_id;
    const id=crypto.randomUUID(),t=now();
    const insert=await this.db.prepare(
      `INSERT OR IGNORE INTO runs(id,workflow_id,version_id,instance_id,admission_key,request_digest,inputs,start_state,outcome,created_at,updated_at,parent_run_id,parent_step_id,child_mode,call_depth) SELECT ?,?,?,?,?,?,?, 'reserved','queued',?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM workflows WHERE id=? AND state='active' AND active_version_id=?) AND (SELECT COUNT(*) FROM runs WHERE outcome IN ('queued','running')) < ${LIMITS.admissionCap}`
    ).bind(id,args.workflow_id,version,id,key,request_digest,inputJson,t,t,args.parent_run_id,args.parent_step_id,args.mode,depth,args.workflow_id,version).run();
    if(!insert.meta.changes){
      const prior=await this.db.prepare('SELECT * FROM runs WHERE workflow_id=? AND admission_key=?').bind(args.workflow_id,key).first<RunRow>();
      if(prior){
        if(prior.request_digest!==request_digest)throw new StateError('idempotency_conflict');
        return this.reconcileStart(prior);
      }
      await releaseWaitingRun(this.db,args.parent_run_id);
      const latest=await this.row(args.workflow_id);
      if(latest.state!=='active'||latest.active_version_id!==version)throw new StateError('workflow_not_active');
      throw new StateError('run_capacity_exceeded');
    }
    try{
      await this.env.WORKFLOW.create({id,params:{run_id:id}});
      await this.db.prepare("UPDATE runs SET start_state='started',updated_at=? WHERE id=? AND start_state IN ('reserved','start_unknown')").bind(now(),id).run();
      return {run_id:id,published_version_id:version,status:'queued' as const,start_state:'started' as const};
    }catch{
      await this.db.prepare("UPDATE runs SET start_state='start_unknown',updated_at=? WHERE id=? AND start_state='reserved'").bind(now(),id).run();
      const prior=await this.db.prepare('SELECT * FROM runs WHERE id=?').bind(id).first<RunRow>();
      return this.reconcileStart(prior!);
    }
  }
  async start(workflow_id:string,inputs:Record<string,unknown>={},idempotency_key?:string,mode:'manual'|'event'='manual',expectedVersionId?:string){
    assertId(workflow_id);
    if(idempotency_key!==undefined){
      const reserved=/^evt_[0-9a-f]{64}$/.test(idempotency_key);
      if(idempotency_key.length>128||!safeId(idempotency_key)||(mode==='manual'&&reserved)||(mode==='event'&&!reserved))throw new StateError(mode==='event'&&!reserved?'invalid_event_id':'invalid_idempotency_key');
    }
    const inputJson=json(inputs);
    const request_digest=await digest(canonicalJsonString(inputs));
    // An accepted admission keeps its pinned version across republish/pause.
    if(idempotency_key){
      const original=await this.db.prepare('SELECT * FROM runs WHERE workflow_id=? AND admission_key=?').bind(workflow_id,idempotency_key).first<RunRow>();
      if(original){if(original.request_digest!==request_digest)throw new StateError('idempotency_conflict');return this.reconcileStart(original);}
    }
    // Reconcile only the bounded number of stale starts occupying the eight
    // Workflow admission slots. This is ingress repair, not a new scheduler.
    const stale=await this.db.prepare("SELECT * FROM runs WHERE outcome='queued' AND start_state IN ('reserved','start_unknown') AND created_at<=? ORDER BY created_at ASC LIMIT 8")
      .bind(now()-START_RECONCILE_WINDOW_MS).all<RunRow>();
    for(const old of stale.results)await this.reconcileStart(old);
    // When all eight slots are occupied, bounded ingress repair also checks
    // started Workflows whose native engine completed but D1 never finalized.
    const capacity=await this.db.prepare("SELECT COUNT(*) AS count FROM runs WHERE outcome IN ('queued','running')").first<{count:number}>();
    if((capacity?.count??0)>=LIMITS.admissionCap){
      const active=await this.db.prepare("SELECT * FROM runs WHERE start_state='started' AND outcome IN ('queued','running') ORDER BY created_at ASC LIMIT 8").all<RunRow>();
      for(const run of active.results){
        const observed=await observeInstance(this.env.WORKFLOW,run.instance_id);
        if(observed.kind==='found')await this.settleNativeOutcome(run,observed.status);
      }
    }
    const wf=await this.row(workflow_id);
    if(wf.state!=='active'||!wf.active_version_id)throw new StateError('workflow_not_active');
    if(expectedVersionId!==undefined&&wf.active_version_id!==expectedVersionId)throw new StateError('published_version_changed');
    const version=wf.active_version_id;
    const id=crypto.randomUUID(),t=now();
    const insert=await this.db.prepare(
      `INSERT OR IGNORE INTO runs(id,workflow_id,version_id,instance_id,admission_key,request_digest,inputs,start_state,outcome,created_at,updated_at) SELECT ?,?,?,?,?,?,?, 'reserved','queued',?,? WHERE EXISTS (SELECT 1 FROM workflows WHERE id=? AND state='active' AND active_version_id=?) AND (SELECT COUNT(*) FROM runs WHERE outcome IN ('queued','running')) < ${LIMITS.admissionCap}`
    ).bind(id,workflow_id,version,id,idempotency_key??null,request_digest,inputJson,t,t,workflow_id,version).run();
    if(!insert.meta.changes){
      if(idempotency_key){const prior=await this.db.prepare('SELECT * FROM runs WHERE workflow_id=? AND admission_key=?').bind(workflow_id,idempotency_key).first<RunRow>();
        if(prior){if(prior.request_digest!==request_digest)throw new StateError('idempotency_conflict');return this.reconcileStart(prior);}}
      const latest=await this.row(workflow_id);
      if(latest.state!=='active')throw new StateError('workflow_not_active');
      if(latest.active_version_id!==version)throw new StateError('published_version_changed');
      throw new StateError('run_capacity_exceeded');
    }
    try{await this.env.WORKFLOW.create({id,params:{run_id:id}});await this.db.prepare("UPDATE runs SET start_state='started',updated_at=? WHERE id=? AND start_state IN ('reserved','start_unknown')").bind(now(),id).run();return {run_id:id,published_version_id:version,status:'queued',start_state:'started'};}
    catch {
      await this.db.prepare("UPDATE runs SET start_state='start_unknown',updated_at=? WHERE id=? AND start_state='reserved'").bind(now(),id).run();
      const prior=await this.db.prepare('SELECT * FROM runs WHERE id=?').bind(id).first<RunRow>();return this.reconcileStart(prior!);
    }
  }
  private async reconcileStart(row:RunRow){
    const started=()=>({run_id:row.id,published_version_id:row.version_id,status:row.outcome,start_state:'started',idempotent_replay:true});
    if(row.start_state==='started')return started();
    // D1 business terminal state is authoritative. An existing instance can
    // still repair a lost start ACK; a missing/unknown instance must never
    // downgrade the known result or cause a replacement execution.
    if(['succeeded','failed','indeterminate','cancelled'].includes(row.outcome)){
      const observation=await observeInstance(this.env.WORKFLOW,row.instance_id);
      if(observation.kind==='found'){
        await this.db.prepare("UPDATE runs SET start_state='started',updated_at=? WHERE id=? AND start_state IN ('reserved','start_unknown')").bind(now(),row.id).run();
      }
      return {run_id:row.id,published_version_id:row.version_id,status:row.outcome,start_state:observation.kind==='found'?'started':row.start_state,idempotent_replay:true};
    }
    // A generic get/status rejection is NOT evidence that an instance is absent.
    // In particular, network failures must never cause an automatic create.
    let observation=await observeInstance(this.env.WORKFLOW,row.instance_id);
    if(observation.kind==='found'){
      await this.db.prepare("UPDATE runs SET start_state='started',updated_at=? WHERE id=? AND start_state IN ('reserved','start_unknown')").bind(now(),row.id).run();
      return started();
    }
    // A cancel request must not create the Workflow instance it asked to stop.
    if(observation.kind==='missing' && row.cancel_requested_at!=null){
      return {run_id:row.id,published_version_id:row.version_id,status:row.outcome,start_state:row.start_state,idempotent_replay:true};
    }
    if(observation.kind==='missing' && row.outcome==='queued' && now()-row.created_at<START_RECONCILE_WINDOW_MS){
      // Positive missing evidence: create only with the ORIGINAL deterministic ID.
      try{await this.env.WORKFLOW.create({id:row.instance_id,params:{run_id:row.id}});}catch{}
      observation=await observeInstance(this.env.WORKFLOW,row.instance_id);
      if(observation.kind==='found'){
        await this.db.prepare("UPDATE runs SET start_state='started',updated_at=? WHERE id=? AND start_state IN ('reserved','start_unknown')").bind(now(),row.id).run();
        return started();
      }
    }
    if(observation.kind==='missing' && row.outcome==='queued' && now()-row.created_at>=START_RECONCILE_WINDOW_MS){
      await this.db.prepare("UPDATE runs SET outcome='indeterminate',error_code='start_unconfirmed',updated_at=? WHERE id=? AND outcome='queued' AND start_state IN ('reserved','start_unknown') AND created_at<=?")
        .bind(now(),row.id,now()-START_RECONCILE_WINDOW_MS).run();
    }
    const latest=await this.db.prepare('SELECT * FROM runs WHERE id=?').bind(row.id).first<RunRow>();
    if(latest?.outcome==='indeterminate')return {run_id:row.id,published_version_id:row.version_id,status:'indeterminate',start_state:latest.start_state,idempotent_replay:true};
    if(latest?.start_state==='started')return {run_id:row.id,published_version_id:row.version_id,status:latest.outcome,start_state:'started',idempotent_replay:true};
    // Unknown lookup error: retain quota and audit identity until observation works.
    return {run_id:row.id,published_version_id:row.version_id,status:'start_unknown',start_state:'start_unknown',idempotent_replay:true};
  }
  private async settleNativeOutcome(row:RunRow, native:string):Promise<RunRow>{
    if(row.start_state!=='started'||!['queued','running'].includes(row.outcome))return row;
    const terminalError=unresolvedNativeTerminalError(native,row.outcome);
    // Our own terminate() is not an unexplained orchestration failure.
    if(terminalError==='orchestration_terminated' && row.cancel_requested_at!=null) return row;
    if(terminalError){
      await this.db.prepare("UPDATE runs SET outcome='indeterminate',error_code=?,updated_at=? WHERE id=? AND outcome IN ('queued','running')")
        .bind(terminalError,now(),row.id).run();
      return (await this.db.prepare('SELECT * FROM runs WHERE id=?').bind(row.id).first<RunRow>())!;
    }
    if(native==='complete'){
      if(row.native_complete_seen_at===null){
        await this.db.prepare("UPDATE runs SET native_complete_seen_at=? WHERE id=? AND native_complete_seen_at IS NULL AND outcome IN ('queued','running')")
          .bind(now(),row.id).run();
      }else if(shouldExpireUnconfirmedOutcome(native,row.outcome,row.native_complete_seen_at,now())){
        await this.db.prepare("UPDATE runs SET outcome='indeterminate',error_code='outcome_unconfirmed',updated_at=? WHERE id=? AND native_complete_seen_at<=? AND outcome IN ('queued','running')")
          .bind(now(),row.id,now()-OUTCOME_SETTLE_WINDOW_MS).run();
      }
    }else if(row.native_complete_seen_at!==null){
      await this.db.prepare("UPDATE runs SET native_complete_seen_at=NULL WHERE id=? AND outcome IN ('queued','running')")
        .bind(row.id).run();
    }
    return (await this.db.prepare('SELECT * FROM runs WHERE id=?').bind(row.id).first<RunRow>())!;
  }
  async status(run_id:string){
    assertId(run_id);let row=await this.db.prepare('SELECT * FROM runs WHERE id=?').bind(run_id).first<RunRow>();
    if(!row)throw new StateError('run_not_found');
    if(row.start_state==='reserved'||row.start_state==='start_unknown'){
      await this.reconcileStart(row);
      row=(await this.db.prepare('SELECT * FROM runs WHERE id=?').bind(run_id).first<RunRow>())!;
    }
    let native='unknown';
    if(row.start_state==='started' && ['queued','running'].includes(row.outcome)){
      const observed=await observeInstance(this.env.WORKFLOW,row.instance_id);
      if(observed.kind==='found'){
        native=observed.status;
        row=await this.settleNativeOutcome(row,native);
      }
    }
    let cancellation:RunCancellation|undefined;
    if(row.cancel_requested_at!=null){
      cancellation=await reconcileRunCancellation(this.db,this.env,run_id)??undefined;
      row=(await this.db.prepare('SELECT * FROM runs WHERE id=?').bind(run_id).first<RunRow>())!;
    }
    const stored=(await this.db.prepare('SELECT step_id,status,error_code,output FROM run_steps WHERE run_id=? ORDER BY step_id').bind(run_id).all<{step_id:string;status:string;error_code:string|null;output:string|null}>()).results;
    const version=await this.db.prepare('SELECT plan FROM workflow_versions WHERE id=?').bind(row.version_id).first<{plan:string}>();
    if(!version)throw new StateError('version_missing');
    const asyncActions=await githubAsyncViewsForRun(this.db,run_id,row.outcome,row.error_code,now());
    const terminal=['succeeded','failed','indeterminate','cancelled'].includes(row.outcome)||native==='complete';
    const byId=new Map(stored.map(s=>[s.step_id,s]));
    const planSteps=(JSON.parse(version.plan) as Plan).steps;
    const visible:string[]=[];
    for(const step of planSteps){
      visible.push(step.id);
      if(step.uses!=='flow.expand') continue;
      const snap=byId.get(expansionSnapshotId(step.id));
      if(!snap?.output) continue;
      try{
        const parsed=JSON.parse(snap.output) as {items?:unknown};
        if(!Array.isArray(parsed.items)) continue;
        for(let index=0;index<parsed.items.length;index++) visible.push(expansionChildId(step.id,index));
      }catch{/* A corrupt snapshot still leaves the template step visible. */}
    }
    const steps=visible.map(stepId=>{
      const saved=byId.get(stepId);
      const base=saved && ['succeeded','failed','skipped','indeterminate'].includes(saved.status)
        ?{step_id:saved.step_id,status:saved.status,error_code:saved.error_code}
        :{step_id:stepId,status:terminal?'indeterminate':saved?.status??'waiting',error_code:saved?.error_code??null};
      const asyncAction=asyncActions.get(stepId);
      return asyncAction?{...base,async_action:asyncAction}:base;
    }).sort((a,b)=>a.step_id<b.step_id?-1:a.step_id>b.step_id?1:0);
    const compensation=publicCompensation(stored.find(item=>item.step_id==='saga:compensation')?.output);
    return {run_id,workflow_id:row.workflow_id,published_version_id:row.version_id,start_state:row.start_state,status:['succeeded','failed','indeterminate','cancelled'].includes(row.outcome)?row.outcome:row.start_state!=='started'?'start_unknown':applyStatus(native,row.outcome),...(cancellation?{cancellation}:{}),...(compensation?{compensation}:{}),steps};
  }
  async result(run_id:string){
    const meta=await this.status(run_id);
    const row=await this.db.prepare('SELECT result,error_code FROM runs WHERE id=?').bind(run_id).first<{result:string|null;error_code:string|null}>();
    return limitResult({...meta,result:row?.result?JSON.parse(row.result):null,error_code:row?.error_code??null},64*1024);
  }
}
