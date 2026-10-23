import { compilePlan, PlanError, canonicalJsonString } from './plan.ts';
import { GITHUB_TRIGGER_EVENTS, isConfiguredSecret, LIMITS, TRIGGER_REPOSITORY, TRIGGER_SOURCE_ID } from './capabilities.ts';
import { PRODUCTION_PORTAL_ENDPOINT, TRUSTED_PORTAL_ENDPOINT } from './mcp-public-fetch.ts';
import {githubAsyncViewsForRun} from './github-async.ts';
import {reconcileRunCancellation, type RunCancellation} from './run-cancel.ts';
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
import type { Plan, ReadonlyOperation } from './plan.ts';

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
  // For production MCP, pin to the existing MCP Portal;
  // for isolated test MCP, pin to test-mcp (never selected by Draft input).
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

  // Legacy personal direct-target mode requires a separate explicit opt-in.
  // Without it, MCP must have a pinned Portal endpoint at Publish and Run.
};
export class StateError extends Error {
  code:string;
  constructor(code: string) { super(code); this.code=code; this.name='StateError'; }
}
const now=()=>Date.now();
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
function assertPublishedTriggers(plan:Plan, env:Env){
  for(const trigger of plan.triggers??[]){
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
function mcpGrants(plan:Plan):ReadonlyOperation[]{
  return [...new Map(plan.steps.filter(s=>s.uses==='mcp.call').map(s=>{
    const grant:ReadonlyOperation={endpoint:s.with.endpoint as string,tool:s.with.tool as string,scope:'read',schema_digest:s.with.schema_digest as string};
    return [JSON.stringify(grant),grant] as const;
  })).values()];
}
function issueMessage(code:string, detail?:string):string{
  switch(code){
    case 'unsupported_field': return `Field "${detail}" is not supported.`;
    case 'unsupported_capability': return 'This action is not supported.';
    case 'unsupported_operation_scope': return 'MCP scope must be read.';
    case 'unsupported_github_capability': return 'Only github.workflow.check can be compiled.';
    case 'invalid_reference':
    case 'invalid_step_reference': return 'The reference is not allowed from this step.';
    case 'invalid_yaml_or_json': return 'The definition is not valid YAML or JSON.';
    case 'invalid_endpoint': return 'The MCP endpoint is not a canonical public HTTPS URL.';
    case 'excessive_parallelism': return `More than ${LIMITS.maxParallel} steps would run at the same time.`;
    case 'unbounded_loop': return `repeat.times must be an integer from 1 to ${LIMITS.maxLoopIterations}.`;
    case 'loop_budget_exceeded': return `The loop exceeds ${LIMITS.maxLoopIterations} iterations or ${LIMITS.maxExpandedSteps} expanded steps.`;
    case 'dynamic_expansion': return 'Dynamic expansion is not implemented.';
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
    case 'invalid_trigger': return 'triggers must declare one webhook, one GitHub event, or both.';
    case 'duplicate_trigger': return 'Each trigger id and type can be declared once.';
    case 'invalid_trigger_source': return 'Webhook source must be the configured source id.';
    case 'invalid_trigger_event': return 'The trigger event name is not allowed.';
    case 'invalid_repository': return 'GitHub repository must be owner/name.';
    case 'unsupported_github_event': return 'This GitHub event cannot start a business Run.';
    case 'invalid_definition': return 'The definition must be an object.';
    case 'invalid_expression': return 'The expression must be an object.';
    case 'invalid_argument_key': return 'This object key is not allowed.';
    case 'definition_too_deep': return 'The definition is nested too deeply.';
    default: return 'The definition is invalid.';
  }
}
function safeSuggestion(suggestion?:string):string|undefined{
  if(!suggestion)return undefined;
  if(/\b(write|shell|secret|token|password)\b/i.test(suggestion)||/skip/i.test(suggestion))return undefined;
  return suggestion;
}
function validationIssue(error:PlanError){
  const code=error.message.split(':')[0]??'invalid_definition';
  const detail=error.message.startsWith(code+':')?error.message.slice(code.length+1):undefined;
  const suggestion=safeSuggestion(error.suggestion);
  return {code, message:issueMessage(code, detail), ...(error.path?{path:error.path}:{}), ...(suggestion?{suggestion}:{})};
}
async function compileValidation(source:string){
  try{
    const {digest,plan}=await compilePlan(source);
    const required_approvals=mcpGrants(plan);
    return {valid:true as const,digest,steps:plan.steps.length,issues:[] as [],
      ...(required_approvals.length?{required_approvals}:{}),
      ...(plan.steps.some(s=>s.uses==='github.run')?{requires_heavy_execution_approval:true as const}:{})};
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
    return {workflows:out.results.map(r=>({workflow_id:r.id,name:r.name,draft_revision:r.draft_revision,published_version_id:r.active_version_id,state:r.state}))};}
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
    return compileValidation(row.draft);
  }
  async validateDefinition(definition:string){
    return compileValidation(definition);
  }
  async publish(workflow_id:string,expected_revision:number,approved_operations:ReadonlyOperation[]=[],accept_target_risks=false,approve_heavy_execution=false){
    assertId(workflow_id);const row=await this.row(workflow_id);
    if(row.draft_revision!==expected_revision)throw new StateError('revision_conflict');
    const {plan,digest:plan_digest}=await compilePlan(row.draft);
    // The owner must explicitly approve the exact immutable URL + tool + scope.
    // Publishing an arbitrary Draft is not itself an external-operation grant.
    const required=mcpGrants(plan).sort((a,b)=>JSON.stringify(a)<JSON.stringify(b)?-1:JSON.stringify(a)>JSON.stringify(b)?1:0);
    const provided=approved_operations.slice().sort((a,b)=>JSON.stringify(a)<JSON.stringify(b)?-1:JSON.stringify(a)>JSON.stringify(b)?1:0);
    if(JSON.stringify(required)!==JSON.stringify(provided))throw new StateError('external_approval_required');
    if(required.length){
      const portal=this.env.MCP_PORTAL_ENDPOINT;
      if(portal===undefined)throw new StateError('portal_target_not_configured');
      if(![TRUSTED_PORTAL_ENDPOINT,PRODUCTION_PORTAL_ENDPOINT].includes(portal) ||
         required.some(grant=>grant.endpoint!==portal))throw new StateError('portal_target_not_authorized');
    }
    // Personal trusted-target mode: a separate explicit risk acknowledgement
    // is required at each Publish in addition to exact per-operation grants.
    // This is an authenticated API assertion, not proof of human interaction.
    if(required.length && accept_target_risks!==true)throw new StateError('target_risk_acknowledgment_required');
    const hasGithub=plan.steps.some(s=>s.uses==='github.run');
    if(hasGithub && approve_heavy_execution!==true)throw new StateError('github_execution_approval_required');
    assertPublishedTriggers(plan,this.env);
    const scopedPlan:Plan=required.length?{...plan,mcp_approvals:required,mcp_target_risks_accepted:true}:plan;
    const publishedPlan:Plan=hasGithub?{...scopedPlan,github_execution_approved:true}:scopedPlan;
    // Repeated Publish of an unchanged Draft resolves to its existing Version.
    if(row.active_version_id){
      const current=await this.db.prepare('SELECT digest FROM workflow_versions WHERE id=? AND workflow_id=?').bind(row.active_version_id,workflow_id).first<{digest:string}>();
      if(current?.digest===plan_digest)return {workflow_id,published_version_id:row.active_version_id,digest:plan_digest,state:row.state};
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
        if(current?.digest===plan_digest)return {workflow_id,published_version_id:latest.active_version_id,digest:plan_digest,state:latest.state};
      }
      throw new StateError('revision_conflict');
    }
    return {workflow_id,published_version_id:version,digest:plan_digest,state:row.state==='paused'?'paused':'active'};
  }
  async admitEvent(workflow_id:string,admission:{kind:'webhook'|'github_event';event:string;event_id:string|null;source:string;payload:Record<string,unknown>}){
    assertId(workflow_id);
    const inputs={event:admission.event,event_id:admission.event_id,payload:admission.payload};
    const key=admission.event_id===null?undefined:'evt_'+await digest(admission.kind+'\0'+admission.event_id);
    if(key){
      const existing=await this.db.prepare('SELECT id FROM runs WHERE workflow_id=? AND admission_key=?').bind(workflow_id,key).first<{id:string}>();
      if(existing)return {...await this.start(workflow_id,inputs,key,'event'),dedupe:'stable_event_id' as const,exactly_once:false as const};
    }
    await this.assertActiveTrigger(workflow_id,admission);
    const admitted=await this.start(workflow_id,inputs,key,'event');
    return {...admitted,dedupe:key?'stable_event_id' as const:'not_claimed' as const,exactly_once:false as const};
  }
  private async assertActiveTrigger(workflow_id:string,admission:{kind:'webhook'|'github_event';event:string;source:string}){
    const wf=await this.row(workflow_id);
    if(wf.state!=='active'||!wf.active_version_id)throw new StateError('workflow_not_active');
    const version=await this.db.prepare('SELECT plan FROM workflow_versions WHERE id=? AND workflow_id=?').bind(wf.active_version_id,workflow_id).first<{plan:string}>();
    if(!version)throw new StateError('version_missing');
    const plan=JSON.parse(version.plan) as Plan;
    const trigger=(plan.triggers??[]).find(item=>item.type===admission.kind);
    if(!trigger)throw new StateError('unauthorized_source');
    if(trigger.type==='webhook'){
      if(trigger.source!==this.env.WEBHOOK_TRIGGER_SOURCE||admission.source!==trigger.source)throw new StateError('unauthorized_source');
      if(trigger.event!==admission.event)throw new StateError('unauthorized_event');
      return;
    }
    if(trigger.repository!==this.env.GITHUB_EXECUTOR_REPOSITORY||admission.source!==trigger.repository)throw new StateError('unauthorized_source');
    if(!(GITHUB_TRIGGER_EVENTS as readonly string[]).includes(admission.event)||!trigger.events.includes(admission.event))throw new StateError('unauthorized_event');
  }
  async cancel(run_id:string){
    assertId(run_id);
    const existing=await this.db.prepare('SELECT id,cancel_requested_at FROM runs WHERE id=?').bind(run_id).first<{id:string;cancel_requested_at:number|null}>();
    if(!existing)throw new StateError('run_not_found');
    if(existing.cancel_requested_at==null){
      await this.db.prepare('UPDATE runs SET cancel_requested_at=?,updated_at=? WHERE id=? AND cancel_requested_at IS NULL').bind(now(),now(),run_id).run();
    }
    return this.status(run_id);
  }
  async pause(workflow_id:string){assertId(workflow_id);const x=await this.db.prepare("UPDATE workflows SET state='paused',updated_at=? WHERE id=? AND state='active'").bind(now(),workflow_id).run();if(!x.meta.changes)throw new StateError('not_active');return {workflow_id,state:'paused'};}
  async resume(workflow_id:string){assertId(workflow_id);const x=await this.db.prepare("UPDATE workflows SET state='active',updated_at=? WHERE id=? AND state='paused' AND active_version_id IS NOT NULL").bind(now(),workflow_id).run();if(!x.meta.changes)throw new StateError('not_paused');return {workflow_id,state:'active'};}
  async start(workflow_id:string,inputs:Record<string,unknown>={},idempotency_key?:string,mode:'manual'|'event'='manual'){
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
    if((capacity?.count??0)>=8){
      const active=await this.db.prepare("SELECT * FROM runs WHERE start_state='started' AND outcome IN ('queued','running') ORDER BY created_at ASC LIMIT 8").all<RunRow>();
      for(const run of active.results){
        const observed=await observeInstance(this.env.WORKFLOW,run.instance_id);
        if(observed.kind==='found')await this.settleNativeOutcome(run,observed.status);
      }
    }
    const wf=await this.row(workflow_id);
    if(wf.state!=='active'||!wf.active_version_id)throw new StateError('workflow_not_active');
    const version=wf.active_version_id;
    const id=crypto.randomUUID(),t=now();
    const insert=await this.db.prepare(
      "INSERT OR IGNORE INTO runs(id,workflow_id,version_id,instance_id,admission_key,request_digest,inputs,start_state,outcome,created_at,updated_at) SELECT ?,?,?,?,?,?,?, 'reserved','queued',?,? WHERE EXISTS (SELECT 1 FROM workflows WHERE id=? AND state='active' AND active_version_id=?) AND (SELECT COUNT(*) FROM runs WHERE outcome IN ('queued','running')) < 8"
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
    const stored=(await this.db.prepare('SELECT step_id,status,error_code FROM run_steps WHERE run_id=? ORDER BY step_id').bind(run_id).all<{step_id:string;status:string;error_code:string|null}>()).results;
    const version=await this.db.prepare('SELECT plan FROM workflow_versions WHERE id=?').bind(row.version_id).first<{plan:string}>();
    if(!version)throw new StateError('version_missing');
    const asyncActions=await githubAsyncViewsForRun(this.db,run_id,row.outcome,row.error_code,now());
    const terminal=['succeeded','failed','indeterminate','cancelled'].includes(row.outcome)||native==='complete';
    const byId=new Map(stored.map(s=>[s.step_id,s]));
    const steps=(JSON.parse(version.plan) as Plan).steps.map(s=>{
      const saved=byId.get(s.id);
      const base=saved && ['succeeded','failed','skipped','indeterminate'].includes(saved.status)
        ?saved
        :{step_id:s.id,status:terminal?'indeterminate':saved?.status??'waiting',error_code:saved?.error_code??null};
      const asyncAction=asyncActions.get(s.id);
      return asyncAction?{...base,async_action:asyncAction}:base;
    }).sort((a,b)=>a.step_id<b.step_id?-1:a.step_id>b.step_id?1:0);
    return {run_id,workflow_id:row.workflow_id,published_version_id:row.version_id,start_state:row.start_state,status:['succeeded','failed','indeterminate','cancelled'].includes(row.outcome)?row.outcome:row.start_state!=='started'?'start_unknown':applyStatus(native,row.outcome),...(cancellation?{cancellation}:{}),steps};
  }
  async result(run_id:string){
    const meta=await this.status(run_id);
    const row=await this.db.prepare('SELECT result,error_code FROM runs WHERE id=?').bind(run_id).first<{result:string|null;error_code:string|null}>();
    return limitResult({...meta,result:row?.result?JSON.parse(row.result):null,error_code:row?.error_code??null},64*1024);
  }
}
