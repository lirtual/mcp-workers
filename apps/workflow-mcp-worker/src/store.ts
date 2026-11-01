import {requestGitHubActionCancellation} from './github-action-cancel.ts';
import {workflowGitHubArtifactReferences} from './github-action-artifacts.ts';
import {compensateCancelledSessions} from './saga.ts';
import {cancelAwaitedChild} from './child-cancel.ts';
import {ACTIVE_CAPACITY_UNITS_SQL,capacityAdmissionPredicate} from './child-capacity.ts';
import { PRODUCTION_PORTAL_ENDPOINT } from './mcp-public-fetch.ts';
import {reconcilePersistedGitHubActionAttempt} from './github-action-attempt-reconcile.ts';
import {releaseVerifiedSessionSlot,releaseNeverDispatchedSessionSlot} from './github-action-session.ts';
import { discoverGitHubActions } from './github-action-discovery.ts';
import { verifyActionDispatchRef } from './github-action-dispatch-ref.ts';
import {containsDynamicForeachTaskInputs,validateForeachTaskInputTemplate,isSessionDurationInputRef} from './github-action-inputs.ts';
import { reviewedGitHubAction, assertReviewedGitHubAction, type ReviewedGitHubAction } from './github-action-review.ts';
import { approvedActionRepositories } from './github-action-catalog.ts';
import { compilePlan, PlanError, canonicalJsonString } from './plan.ts';
import {observeInstance, shouldExpireUnconfirmedOutcome, unresolvedNativeTerminalError, OUTCOME_SETTLE_WINDOW_MS} from './instance-observation.ts';
import YAML from 'yaml';
import {cloudflareActionManifest} from './cloudflare-action-contract.ts';
import {encryptEnvshareAdmission,isEnvsharePlan,buildEnvshareLink} from './envshare-transient.ts';
import {recordRuntimeApproval} from './runtime-approval.ts';
import {portalAuthorization,changePortalAuthorization} from './portal-authorization.ts';
function draftName(definition:string):string {
  if(!definition || new TextEncoder().encode(definition).byteLength>32768)throw new StateError('definition_too_large');
  try {
    const parsed=YAML.parse(definition,{uniqueKeys:true});
    if(parsed && typeof parsed==='object' && typeof parsed.name==='string' && parsed.name.trim())
      return parsed.name.slice(0,120);
  }catch{}
  return 'Untitled Draft';
}
import type { Plan, Step, ReadonlyOperation } from './plan.ts';
import {httpOperation,type HttpOperation} from './http-action.ts';
import {httpAuthorization,changeHttpAuthorization} from './http-authorization.ts';

export type Env = {
  DB: D1Database;
  MCP_ACCESS_TOKEN: string;
  WORKFLOW: {
    create(options:{id:string;params:{run_id:string}}):Promise<unknown>;
    get(id:string):Promise<{status():Promise<{status:string}>;terminate?(options?:{rollback?:boolean}):Promise<void>;sendEvent?(event:{type:string;payload:unknown}):Promise<void>}>;
  };
  // Enabled only through the explicit selected-Worker production release.
  // Optional, MCP-only machine identity for the pinned Cloudflare MCP Portal.
  MCP_PORTAL_CLIENT_ID?: string;
  MCP_PORTAL_CLIENT_SECRET?: string;
  // The sole approved Portal is fixed by release configuration.
  MCP_PORTAL_ENDPOINT?: string;
  // Production GitHub requires explicit opt-in and fixed OIDC/executor pins.
  WORKFLOW_GITHUB_DISPATCH_TOKEN?: string;
  // Server-owned, read-only Action discovery scopes; no publication or execution grant.
  GITHUB_ACTION_APPROVED_REPOSITORIES?: string;
  // Separate GitHub-issued OIDC audience for immutable Action claims.
  // This is an identity binding, not an execution feature switch.
  GITHUB_ACTION_OIDC_AUDIENCE?: string;
  // Canonical 256-bit AES-GCM key for short-lived Session data.
  SESSION_RUNTIME_DATA_KEY?: string;
  // New source-reviewed single Actions binding. Legacy bindings remain read-only during cutover.
  ACTIONS_DEPLOYMENT_ID?: string;
  ACTIONS?: {
    listActions():Promise<Array<{action_id:string}>>;
    getContract(action_id:string,contract_digest?:string):Promise<{deployment_id:string;contract_digest:string}>;
    execute(action_id:string,input:unknown):Promise<{status:string;input_digest:string}>;
    getReceipt(action_id:string,query:unknown):Promise<{status:string}>;
    getBinding(action_id:string):Promise<{generation:number;ready:boolean}>;
  };
  // The Worker Version ID is pinned by the separately authorized release.
  BARK_ACTION_DEPLOYMENT_ID?: string;
  BARK_ACTION_PROVIDER?: {
    getContract():Promise<{deployment_id:string;contract_digest:string}>;
    sendNotification(input:{invocation_id:string;deployment_id:string;contract_digest:string;
      input_digest:string;notification:Record<string,unknown>}):Promise<{status:string;input_digest:string}>;
  };
  WEIXIN_ACTION_DEPLOYMENT_ID?: string;
  WEIXIN_ACTION_PROVIDER?: {
    getBinding():Promise<{generation:number;ready:boolean}>;
    getContract():Promise<{deployment_id:string;contract_digest:string}>;
    getDownloadContract():Promise<{deployment_id:string;contract_digest:string}>;
    getGenericContract():Promise<{deployment_id:string;contract_digest:string}>;
    sendGenericText(input:{invocation_id:string;binding_generation:number;text:string;deployment_id:string;contract_digest:string}):Promise<{status:string;input_digest:string}>;
    sendDownloadComplete(input:{invocation_id:string;binding_generation:number;deployment_id:string;contract_digest:string}):Promise<{status:string;input_digest:string}>;
    sendText(input:{invocation_id:string;binding_generation:number;session_url:string;deployment_id:string;contract_digest:string}):Promise<{status:string;input_digest:string}>;
    getReceipt(input:{invocation_id:string;binding_generation:number;input_digest:string}):Promise<{status:string}>;
  };

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
export function cleanError(e:unknown):string {
  if(e instanceof StateError||e instanceof PlanError)return e.code;
  // Only our narrowly named discovery failures are safe to expose. Never
  // reflect GitHub response bodies, transport exceptions or request secrets.
  if(e instanceof Error&&/^github_(?:discovery|action_catalog|action_tag_discovery)_[a-z_]{1,40}$/.test(e.message))
    return e.message;
  return 'internal_error';
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
type WorkflowRow={id:string;name:string;draft:string;draft_revision:number;active_version_id:string|null;state:string;deleted_at:number|null};
type VersionRow={id:string;plan:string;digest:string};
type RunRow={id:string;parent_run_id:string|null;workflow_id:string;version_id:string;instance_id:string;request_digest:string;start_state:string;outcome:string;result:string|null;error_code:string|null;inputs:string;created_at:number;updated_at:number;native_complete_seen_at:number|null};
const workflowView=(row:WorkflowRow)=>({workflow_id:row.id,name:row.name,draft_revision:row.draft_revision,definition:row.draft,published_version_id:row.active_version_id,state:row.state});
// A bounded dynamic MCP child requires the same explicit Publish grant as an
// ordinary Step; the compiler has already pinned its exact tool schema.
function approvedMcpSteps(plan:Plan):Array<{with:Record<string,unknown>}>{
  return plan.steps.flatMap(s=>{
    if(s.uses==='mcp.call')return [s];
    if(s.uses!=='flow.foreach'&&s.uses!=='flow.loop')return [];
    const templates=(Array.isArray(s.with.templates)?s.with.templates:[s.with.template]) as
      Array<{uses?:unknown;with?:Record<string,unknown>}|undefined>;
    return templates.filter(t=>t?.uses==='mcp.call'&&!!t.with)
      .map(t=>({with:t!.with!}));
  });
}

/** Include validated dynamic Task templates in the existing exact-source
 * discovery, schema review and explicit owner Publish approval. */
function reviewedGitHubSteps(plan:Plan):Array<{step:Step;path:string}>{
  return plan.steps.flatMap<{step:Step;path:string}>((step,index)=>{
    if(step.uses==='github.run'&&step.with.capability==='github.action')
      return [{step,path:'/steps/'+index+'/with/action'}];
    if(step.uses!=='flow.foreach')return [];
    const children=(Array.isArray(step.with.templates)?step.with.templates:[step.with.template]) as
      Array<{id:string;uses:string;with:Record<string,unknown>}|undefined>;
    return children.flatMap((child,stage)=>
      child?.uses==='github.run'&&child.with?.capability==='github.action'
        ?[{step:{id:child.id,uses:'github.run' as const,needs:step.needs,with:child.with},
           path:'/steps/'+index+'/template/steps/'+stage+'/with/action'}]:[]);
  });
}
export class WorkflowService {
  private env:Env;
  constructor(env:Env){this.env=env;}
  private get db(){return this.env.DB;}
  async list(){
    const out=await this.db.prepare('SELECT * FROM workflows WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 100').all<WorkflowRow>();
    // Four global physical Session slots are independent of the parent
    // Workflow's business outcome. The existing read-only workflow_list is
    // enough to discover a held/uncertain slot and its server-pinned run_id;
    // no separate public Session enumeration capability is necessary.
    const held=await this.db.prepare(`SELECT s.slot,s.run_id,s.step_id,s.state,s.fixed_key,
      s.updated_at,a.state AS attempt_state
      FROM session_executions s
      LEFT JOIN step_attempts a ON a.run_id=s.run_id AND a.step_id=s.step_id
      WHERE s.state!='terminated' ORDER BY s.slot LIMIT 4`)
      .all<{slot:number;run_id:string;step_id:string;state:string;fixed_key:string|null;updated_at:number;attempt_state:string|null}>();
    return {workflows:out.results.map(r=>({workflow_id:r.id,name:r.name,draft_revision:r.draft_revision,published_version_id:r.active_version_id,state:r.state})),
      active_sessions:held.results.map(x=>({slot:x.slot,run_id:x.run_id,
        step_id:x.step_id,session_mode:x.fixed_key?'fixed':'temporary',
        recorded_state:x.state,recorded_at:x.updated_at,
        attempt_state:x.attempt_state,physical_health:'unverified' as const}))};
  }
  async get(workflow_id:string){assertId(workflow_id);const row=await this.row(workflow_id);return workflowView(row);}
  private async row(id:string){const row=await this.db.prepare('SELECT * FROM workflows WHERE id=? AND deleted_at IS NULL').bind(id).first<WorkflowRow>();if(!row)throw new StateError('workflow_not_found');return row;}
  async create(definition:string){
    const name=draftName(definition);
    const id=crypto.randomUUID(),time=now();
    await this.db.prepare('INSERT INTO workflows(id,name,draft,draft_revision,state,created_at,updated_at) VALUES(?,?,?,1,\'draft\',?,?)').bind(id,name,definition,time,time).run();
    return {workflow_id:id,draft_revision:1,state:'draft'};
  }
  async update(workflow_id:string,expected_revision:number,definition:string){
    assertId(workflow_id);if(!Number.isSafeInteger(expected_revision)||expected_revision<1)throw new StateError('invalid_revision');
    const name=draftName(definition);
    const x=await this.db.prepare('UPDATE workflows SET draft=?,name=?,draft_revision=draft_revision+1,updated_at=? WHERE id=? AND draft_revision=? AND deleted_at IS NULL').bind(definition,name,now(),workflow_id,expected_revision).run();
    if(!x.meta.changes) {await this.row(workflow_id);throw new StateError('revision_conflict');}
    return {workflow_id,draft_revision:expected_revision+1};
  }
  private async checkedGitHubActions(plan:Plan):Promise<ReviewedGitHubAction[]> {
    const actions=reviewedGitHubSteps(plan);
    if(!actions.length)return [];
    const token=this.env.WORKFLOW_GITHUB_DISPATCH_TOKEN;
    if(!token)throw new PlanError('github_action_token_missing','/steps');
    const grants=approvedActionRepositories(this.env.GITHUB_ACTION_APPROVED_REPOSITORIES);
    const approved:ReviewedGitHubAction[]=[];
    for(const {step,path} of actions){
      const raw=step.with.action as Record<string,unknown>;
      const expected:ReviewedGitHubAction={
        repository:raw.repository as string,repositoryId:raw.repositoryId as number,
        workflowId:raw.workflowId as number,workflowPath:raw.workflowPath as string,
        commitSha:raw.commitSha as string,type:raw.type as 'task'|'session',
        contractDigest:raw.contractDigest as string,
      };
      const grant=grants.find(g=>g.repository===expected.repository&&
        g.repositoryId===expected.repositoryId);
      if(!grant)throw new PlanError('github_action_repository_not_approved',path+'/repository');
      // Discovery follows the current default branch, but validation and
      // Publish must re-read the exact SHA approved in this Draft. A newer
      // default-branch commit must not invalidate an immutable old review.
      let discovered:Awaited<ReturnType<typeof discoverGitHubActions>>;
      try{discovered=await discoverGitHubActions({...grant,token,commitSha:expected.commitSha});}
      catch{throw new PlanError('github_action_discovery_unavailable',path+'/commitSha');}
      const candidate=discovered.find(d=>d.workflowId===expected.workflowId&&d.workflowPath===expected.workflowPath);
      if(!candidate)throw new PlanError('github_action_not_found',path+'/workflowPath');
      try{
        const given=raw.inputs as Record<string,unknown>;
        const isDynamic=path.includes('/template/steps/0/')&&containsDynamicForeachTaskInputs(given);
        const validated=isDynamic?validateForeachTaskInputTemplate(candidate.contract,given):
          expected.type==='session'&&isSessionDurationInputRef(given.duration_minutes)?
            {...given,duration_minutes:300}:given;
        await assertReviewedGitHubAction(expected,candidate,this.env.GITHUB_ACTION_APPROVED_REPOSITORIES,validated);
        if(isDynamic){
          const controller=plan.steps[Number(path.split('/')[2])];
          if(!controller||controller.uses!=='flow.foreach'||candidate.contract.type!=='task')
            throw Error('unexpected_controller');
          plan.github_dynamic_input_contracts??={};
          plan.github_dynamic_input_contracts[controller.id]=candidate.contract;
        }
      }catch{throw new PlanError('github_action_contract_or_inputs_changed',path+'/inputs');}
      // GitHub workflow_dispatch only accepts a verified branch/Tag ref, never
      // an arbitrary SHA. The existing dispatch/OIDC checks remain mandatory.
      try{await verifyActionDispatchRef(expected,raw.ref as string,token);}
      catch(error){
        const mismatch=error instanceof Error&&error.message==='github_action_ref_mismatch';
        throw new PlanError(mismatch?'github_action_ref_mismatch':'github_action_ref_unconfirmed',path+'/ref');
      }
      approved.push(await reviewedGitHubAction(candidate));
    }
    return approved;
  }
  private async checkedChildWorkflows(plan:Plan,parentId?:string){
    const child=plan.steps.find(s=>s.uses==='flow.child');
    if(!child)return [];
    const id=child.with.workflow_id as string,version=child.with.version_id as string;
    if(parentId===id)throw new PlanError('child_self_invocation','/steps');
    const row=await this.db.prepare(`SELECT w.state,w.active_version_id,v.digest,v.plan
      FROM workflows w JOIN workflow_versions v ON v.workflow_id=w.id AND v.id=?
      WHERE w.id=? AND w.deleted_at IS NULL`).bind(version,id).first<{state:string;active_version_id:string|null;digest:string;plan:string}>();
    if(!row||row.state!=='active'||row.active_version_id!==version)
      throw new PlanError('child_version_not_active','/steps');
    let childPlan:Plan;
    try{childPlan=JSON.parse(row.plan) as Plan;}catch{throw new PlanError('invalid_child_publication','/steps');}
    if(!Array.isArray(childPlan.steps)||childPlan.steps.some(s=>s.uses==='flow.child'))
      throw new PlanError('child_nesting_unsupported','/steps');
    // Until child cancellation/physical terminal propagation has independent
    // evidence, a child must not launch a GitHub Task or Session whose
    // physical lifecycle might outlast the child Workflow.
    if(childPlan.steps.some(s=>s.uses==='github.run'||s.uses==='http.request'||
      (s.uses==='flow.foreach'&&
        (Array.isArray(s.with.templates)?s.with.templates:[s.with.template])
          .some((x:unknown)=>x!==null&&typeof x==='object'&&
            (x as {uses?:unknown}).uses==='github.run'))))
      throw new PlanError('child_external_action_unsupported','/steps');
    return [{workflow_id:id,version_id:version,digest:row.digest}];
  }
  async validate(workflow_id:string,revision:number){
    assertId(workflow_id);const row=await this.row(workflow_id);
    if(row.draft_revision!==revision)throw new StateError('revision_conflict');
    return this.validateDefinition(row.draft);
  }
  /** Validate without creating a Draft or writing D1. Both entrypoints share
   * the exact compiler and reviewed GitHub Action contract. */
  async validateDefinition(definition:string){
    try {
      const {digest,plan}=await compilePlan(definition);
      const reviewed_actions=await this.checkedGitHubActions(plan);
      const reviewed_cloudflare_actions=await Promise.all(plan.steps.filter(s=>s.uses==='action.run')
        .map(async s=>{
          const bark=s.with.provider==='bark';
          const manifest=await cloudflareActionManifest(s.with.action==='weixin.notify_download'?'download':bark?'bark':s.with.action==='dub.shorten_url'?'dub':s.with.action==='envshare.share_text'?'envshare':s.with.action==='litterbox.upload_file'?'litterbox':'unified-generic');
          return {executor:'cloudflare' as const,provider:manifest.provider,action:manifest.action,
            contract_digest:manifest.contract_digest,deployment_id:
              this.env.ACTIONS_DEPLOYMENT_ID??null};
        }));
      const required_children=await this.checkedChildWorkflows(plan);
      const required_approvals=[...new Map(approvedMcpSteps(plan).map(s=>{
        const grant:ReadonlyOperation={endpoint:s.with.endpoint as string,tool:s.with.tool as string,
          scope:s.with.scope as 'read'|'write',schema_digest:s.with.schema_digest as string};
        return [JSON.stringify(grant),grant] as const;
      })).values()];
      const required_http_operations=[...new Map(plan.steps.filter(s=>s.uses==='http.request').map(s=>{
        const operation=httpOperation(s.with);return [JSON.stringify(operation),operation] as const;
      })).values()];
      return {valid:true,digest,steps:plan.steps.length,issues:[],
        ...(required_children.length?{required_children}:{}),
        ...(plan.steps.some(s=>s.approval?.required)?{approval_gates:plan.steps.filter(s=>s.approval?.required).map(s=>({step_id:s.id,when:'before_dispatch',binding:['run_id','step_id','published_version_id'],timeout_seconds:600}))}:{}),
        contract_validation:required_http_operations.length?'http_target_pinned_unverified':reviewed_cloudflare_actions.length?
          'cloudflare_contract_pinned_provider_unverified':required_approvals.length?
          'mcp_schema_pinned_live_call_unverified':'compiler_and_github_revision_verified',
        ...(reviewed_actions.length?{reviewed_actions}:{}),
        ...(reviewed_cloudflare_actions.length?{reviewed_cloudflare_actions,requires_cloudflare_execution_approval:true}:{}),
        ...(required_approvals.length?{required_approvals,
          ...(required_approvals.some(x=>x.scope==='write')?{requires_mcp_write_execution_approval:true}:{})}:{}),
        ...(required_http_operations.length?{required_http_operations,requires_http_execution_approval:true}:{}),
        ...(reviewedGitHubSteps(plan).length?{requires_heavy_execution_approval:true}:{}),
        ...(plan.saga?{saga:{on:plan.saga.on,compensations:plan.steps.filter(s=>s.compensate).map(s=>({step_id:s.id,kind:s.compensate!.kind,source:'approved_github_session'})),acid_rollback:false},requires_saga_compensation_approval:true}:{})};
    }catch(error){
      if(!(error instanceof PlanError))throw error;
      // Never reflect raw YAML, user keys, credentials or upstream errors.
      // Compiler-supplied paths are only for known, safe schema locations.
      const code=error.message.split(':',1)[0];
      const path=error.path!=='/'?error.path:
        code==='invalid_version'?'/version':
        code==='invalid_name'?'/name':
        code==='invalid_inputs'||code==='too_many_inputs'?'/inputs':
        ['invalid_step_count','invalid_step','invalid_step_id','unsupported_capability',
         'approval_not_applicable','multiple_approval_gates_unsupported','invalid_runtime_approval',
         'invalid_step_arguments','invalid_dependencies','cyclic_dependencies',
         'excessive_parallelism','invalid_reference','invalid_step_reference'].includes(code)?'/steps':'/';
      const suggestion=['invalid_foreach_limit','invalid_foreach_items','invalid_foreach_template',
        'unsupported_foreach_template','unsupported_foreach_action','unsupported_foreach_inputs'].includes(code)?
        'Use flow: foreach with max_items 1 to 8 and one result.emit, approved read-only mcp.call or reviewed github.run Task template. GitHub Task inputs may use exact current-item refs only when the reviewed provider contract is pinned and every value is type-checked before dispatch; Sessions and nesting remain unsupported.':
        ['invalid_repeat_count','invalid_repeat_template','unsupported_flow'].includes(code)?
        'Use flow: repeat with a literal times integer from 1 to 8 and one template Action; nested/dynamic loops are not supported. All expanded Steps must fit the maxSteps limit.':
        code.startsWith('invalid_github_event_')||code==='unsupported_github_event'?
        'Use one push event with an exact repository name/id, branch ref and trusted .github/workflows/*.yml relay; declare inputs.github and consult workflow_capabilities.':
        code==='unsupported_trigger'||code==='invalid_triggers'?
        'Use exactly one supported Cron or Webhook trigger from workflow_capabilities.':
        code==='invalid_cron_schedule'?
        'Use one supported five-field UTC Cron schedule from workflow_capabilities; no timezone or Quartz extensions.':
        code==='invalid_webhook_token_hash'?
        'Use only the lowercase SHA-256 hex digest of a securely random 32-byte Webhook bearer token; never include the raw token in a Draft.':
        code==='unsupported_capability'?
        'Call workflow_capabilities and choose a supported Action.':
        code==='unsupported_field'?
        'Remove the unsupported field; use workflow_capabilities for the current schema.':
        ['unknown_output_field','incompatible_output_type'].includes(code)?
        'Use a field and type declared by the source Step; inspect a literal result.emit output or the trusted Action output schema. Unknown dynamic outputs cannot be statically confirmed.':
        ['invalid_reference','invalid_step_reference'].includes(code)?
        'Reference inputs or a declared dependency Step output/status.':
        code==='invalid_yaml_or_json'?
        'Submit valid YAML or JSON without duplicate keys.':
        ['invalid_step_count','excessive_parallelism','too_many_inputs'].includes(code)?
        'Reduce the definition to the limits returned by workflow_capabilities.':
        ['github_action_ref_mismatch','github_action_ref_unconfirmed'].includes(code)?
        'Choose a verified refs/tags/... ref paired with this exact commitSha from workflow_action_list; do not use a branch or raw SHA.':
        ['github_action_contract_or_inputs_changed','github_action_not_found'].includes(code)?
        'Rediscover the released Action contract and inputs with workflow_action_list.':
        code==='github_action_repository_not_approved'?
        'Select a repository already authorized by the Workflow server.':
        undefined;
      return {valid:false,issues:[{code,path,
        message:'Workflow definition rejected: '+code,
        ...(suggestion?{suggestion}:{})}]};
    }
  }
  async portalConnectionStatus(){return portalAuthorization(this.db);}
  async portalConnectionRevoke(){return changePortalAuthorization(this.db,'revoke');}
  async portalConnectionEnable(){return changePortalAuthorization(this.db,'enable');}
  async httpConnectionStatus(){return httpAuthorization(this.db);}
  async httpConnectionRevoke(){return changeHttpAuthorization(this.db,'revoke');}
  async httpConnectionEnable(){return changeHttpAuthorization(this.db,'enable');}
  async publish(workflow_id:string,expected_revision:number,approved_operations:ReadonlyOperation[]=[],accept_target_risks=false,approve_heavy_execution=false,approved_actions:ReviewedGitHubAction[]=[],approved_children:Array<{workflow_id:string;version_id:string;digest:string}>=[],
    approved_cloudflare_actions:Array<{executor:'cloudflare';provider:string;action:string;contract_digest:string;deployment_id:string}>=[],
    approve_cloudflare_execution=false,approved_http_operations:HttpOperation[]=[],approve_http_execution=false,
    approve_mcp_write_execution=false,approve_saga_compensation=false){
    assertId(workflow_id);const row=await this.row(workflow_id);
    if(row.draft_revision!==expected_revision)throw new StateError('revision_conflict');
    const {plan,digest:plan_digest}=await compilePlan(row.draft);
    const reviewedActions=await this.checkedGitHubActions(plan);
    const children=await this.checkedChildWorkflows(plan,workflow_id);
    if(JSON.stringify(children)!==JSON.stringify(approved_children))
      throw new StateError('child_approval_required');
    const ordering=(items:ReviewedGitHubAction[])=>items.map(x=>JSON.stringify(x)).sort();
    if(JSON.stringify(ordering(reviewedActions))!==JSON.stringify(ordering(approved_actions)))
      throw new StateError('github_action_approval_required');
    // The owner must explicitly approve the exact immutable URL + tool + scope.
    // Publishing an arbitrary Draft is not itself an external-operation grant.
    const required=[...new Map(approvedMcpSteps(plan).map(s=>{
      const grant:ReadonlyOperation={endpoint:s.with.endpoint as string,tool:s.with.tool as string,
        scope:s.with.scope as 'read'|'write',schema_digest:s.with.schema_digest as string};
      return [JSON.stringify(grant),grant] as const;
    })).values()].sort((a,b)=>JSON.stringify(a)<JSON.stringify(b)?-1:JSON.stringify(a)>JSON.stringify(b)?1:0);
    const provided=approved_operations.slice().sort((a,b)=>JSON.stringify(a)<JSON.stringify(b)?-1:JSON.stringify(a)>JSON.stringify(b)?1:0);
    if(JSON.stringify(required)!==JSON.stringify(provided))throw new StateError('external_approval_required');
    const hasMcpWrite=required.some(g=>g.scope==='write');
    if(hasMcpWrite!==approve_mcp_write_execution)
      throw new StateError('mcp_write_approval_required');
    if(required.length){
      const portal=this.env.MCP_PORTAL_ENDPOINT;
      if(portal===undefined)throw new StateError('portal_target_not_configured');
      if(portal!==PRODUCTION_PORTAL_ENDPOINT ||
         required.some(grant=>grant.endpoint!==portal))throw new StateError('portal_target_not_authorized');
    }
    // Personal trusted-target mode: a separate explicit risk acknowledgement
    // is required at each Publish in addition to exact per-operation grants.
    // This is an authenticated API assertion, not proof of human interaction.
    if(required.length && accept_target_risks!==true)throw new StateError('target_risk_acknowledgment_required');
    const portalConnection=required.length?await portalAuthorization(this.db):null;
    if(portalConnection&&portalConnection.state!=='enabled')
      throw new StateError('portal_connection_revoked');
    const hasCloudflare=plan.steps.some(s=>s.uses==='action.run');
    let cloudflareGrants:typeof approved_cloudflare_actions=[];
    if(hasCloudflare){
      const step=plan.steps.find(s=>s.uses==='action.run')!;
      const bark=step.with.provider==='bark';
      const deployment=this.env.ACTIONS_DEPLOYMENT_ID;
      const provider=this.env.ACTIONS;
      if(!provider||typeof deployment!=='string'||
         !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deployment))
        throw new StateError('cloudflare_provider_not_configured');
      const contract=await cloudflareActionManifest(step.with.action==='weixin.notify_download'?'download':bark?'bark':step.with.action==='dub.shorten_url'?'dub':step.with.action==='envshare.share_text'?'envshare':step.with.action==='litterbox.upload_file'?'litterbox':'unified-generic');
      // A staged Version ID is not proof of the bound Worker's version.
      let live;
      try{live=await provider.getContract(contract.action,contract.contract_digest);}
      catch{throw new StateError('cloudflare_provider_identity_unconfirmed');}
      if(live.deployment_id!==deployment||live.contract_digest!==contract.contract_digest)
        throw new StateError('cloudflare_provider_identity_mismatch');
      cloudflareGrants=[{executor:'cloudflare',provider:contract.provider,
        action:contract.action,contract_digest:contract.contract_digest,
        deployment_id:deployment}];
      if(approve_cloudflare_execution!==true||
         JSON.stringify(approved_cloudflare_actions)!==JSON.stringify(cloudflareGrants))
        throw new StateError('cloudflare_action_approval_required');
    }else if(approved_cloudflare_actions.length || approve_cloudflare_execution)
      throw new StateError('unexpected_cloudflare_approval');
    const httpRequired=[...new Map(plan.steps.filter(s=>s.uses==='http.request').map(s=>{
      const operation=httpOperation(s.with);return [JSON.stringify(operation),operation] as const;
    })).values()].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const httpProvided=approved_http_operations.slice().sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if(JSON.stringify(httpRequired)!==JSON.stringify(httpProvided)||
       (httpRequired.length>0&&(!approve_http_execution||!accept_target_risks))||
       (httpRequired.length===0&&approve_http_execution))
      throw new StateError('http_action_approval_required');
    const httpConnection=httpRequired.length?await httpAuthorization(this.db):null;
    if(httpConnection&&httpConnection.state!=='enabled')
      throw new StateError('http_connection_revoked');
    if(Boolean(plan.saga)!==approve_saga_compensation)
      throw new StateError('saga_compensation_approval_required');
    const hasGithub=reviewedGitHubSteps(plan).length>0;
    if(hasGithub && approve_heavy_execution!==true)throw new StateError('github_execution_approval_required');
    const scopedPlan:Plan=required.length?{...plan,mcp_approvals:required,mcp_target_risks_accepted:true,
      ...(hasMcpWrite?{mcp_write_execution_approved:true as const}:{}),
      mcp_connection_generation:portalConnection!.generation}:plan;
    const httpPlan:Plan=httpRequired.length?{...scopedPlan,http_approvals:httpRequired,
      http_execution_approved:true,http_connection_generation:httpConnection!.generation}:scopedPlan;
    const grantedPlan:Plan=reviewedActions.length?{...httpPlan,github_action_approvals:reviewedActions}:httpPlan;
    const actionPlan:Plan=hasGithub?{...grantedPlan,github_execution_approved:true}:grantedPlan;
    const withCloudflare:Plan=hasCloudflare?{
      ...actionPlan,cloudflare_execution_approved:true,
      cloudflare_action_approvals:cloudflareGrants}:actionPlan;
    const publishedPlan:Plan={...(children.length?{...withCloudflare,child_approvals:children}:withCloudflare),
      ...(plan.saga?{saga_compensation_approved:true as const}:{})};
    // Repeated Publish of an unchanged Draft resolves to its existing Version.
    if(row.active_version_id){
      const current=await this.db.prepare('SELECT digest FROM workflow_versions WHERE id=? AND workflow_id=?').bind(row.active_version_id,workflow_id).first<{digest:string}>();
      // A revoked generation must never be revived by a same-Draft Publish.
      const previous=await this.db.prepare('SELECT plan FROM workflow_versions WHERE id=?')
        .bind(row.active_version_id).first<{plan:string}>();
      const oldPlan=previous?JSON.parse(previous.plan) as Plan:null;
      if(current?.digest===plan_digest && oldPlan &&
        canonicalJsonString(oldPlan)===canonicalJsonString(publishedPlan))
        return {workflow_id,published_version_id:row.active_version_id,digest:plan_digest,state:row.state};
    }
    const version=crypto.randomUUID(),t=now();
    const batch=await this.db.batch([
      this.db.prepare('UPDATE workflows SET active_version_id=?,state=CASE WHEN state=\'paused\' THEN \'paused\' ELSE \'active\' END,updated_at=? WHERE id=? AND draft_revision=? AND active_version_id IS ? AND deleted_at IS NULL').bind(version,t,workflow_id,expected_revision,row.active_version_id),
      this.db.prepare('INSERT INTO workflow_versions(id,workflow_id,digest,plan,created_at) SELECT ?,id,?,?,? FROM workflows WHERE id=? AND active_version_id=? AND deleted_at IS NULL').bind(version,plan_digest,json(publishedPlan),t,workflow_id,version),
    ]);
    if(!batch[0].meta.changes||!batch[1].meta.changes){
      // A concurrent identical Publish can win the CAS; never report a second version.
      const latest=await this.row(workflow_id);
      if(latest.draft_revision===expected_revision&&latest.active_version_id){
        const current=await this.db.prepare('SELECT digest FROM workflow_versions WHERE id=? AND workflow_id=?').bind(latest.active_version_id,workflow_id).first<{digest:string}>();
        const prior=await this.db.prepare('SELECT plan FROM workflow_versions WHERE id=?')
          .bind(latest.active_version_id).first<{plan:string}>();
        const priorPlan=prior?JSON.parse(prior.plan) as Plan:null;
        if(current?.digest===plan_digest && priorPlan &&
            canonicalJsonString(priorPlan)===canonicalJsonString(publishedPlan))
          return {workflow_id,published_version_id:latest.active_version_id,digest:plan_digest,state:latest.state};
      }
      throw new StateError('revision_conflict');
    }
    return {workflow_id,published_version_id:version,digest:plan_digest,state:row.state==='paused'?'paused':'active'};
  }
  /** The caller must explicitly record one decision; Publish cannot create it.
   * This is an authenticated owner API assertion, not independent human proof.
   * Durable D1 decides; native wake is best effort and never a dispatch grant.
   */
  async approve(run_id:string,step_id:string,published_version_id:string,decision:'approve'|'deny'){
    assertId(run_id);assertId(step_id);assertId(published_version_id);
    if(decision!=='approve'&&decision!=='deny')throw new StateError('invalid_approval_decision');
    const run=await this.db.prepare('SELECT version_id,instance_id,outcome FROM runs WHERE id=?')
      .bind(run_id).first<{version_id:string;instance_id:string;outcome:string}>();
    if(!run)throw new StateError('run_not_found');
    if(run.version_id!==published_version_id)throw new StateError('approval_binding_mismatch');
    if(run.outcome!=='running')throw new StateError('approval_run_not_active');
    const version=await this.db.prepare('SELECT plan FROM workflow_versions WHERE id=?')
      .bind(published_version_id).first<{plan:string}>();
    if(!version)throw new StateError('version_missing');
    const plan=JSON.parse(version.plan) as Plan;
    if(!plan.steps.some(s=>s.id===step_id&&s.uses==='github.run'&&s.approval?.required===true))
      throw new StateError('approval_not_required');
    const gate=await this.db.prepare('SELECT version_id,deadline_at FROM runtime_approval_gates WHERE run_id=? AND step_id=?')
      .bind(run_id,step_id).first<{version_id:string;deadline_at:number}>();
    if(!gate||gate.deadline_at<=now())throw new StateError('approval_not_open');
    if(gate.version_id!==published_version_id)throw new StateError('approval_binding_mismatch');
    const status=await this.db.prepare('SELECT status FROM run_steps WHERE run_id=? AND step_id=?')
      .bind(run_id,step_id).first<{status:string}>();
    if(status?.status!=='waiting_approval')throw new StateError('approval_not_open');
    const recorded=await recordRuntimeApproval(this.db,run_id,step_id,published_version_id,
      decision==='approve'?'approved':'denied',now());
    if(recorded.conflict)throw new StateError('approval_conflict');
    if(recorded.repeated)throw new StateError('approval_already_recorded');
    if(recorded.consumed)throw new StateError('approval_already_used');
    // The 30-second durable wait polls D1 if sendEvent loses its ACK.
    let wake:'sent'|'unknown'='sent';
    try{
      const native=await this.env.WORKFLOW.get(run.instance_id);
      if(!native.sendEvent)throw Error('send_event_unavailable');
      await native.sendEvent({type:'approval-'+step_id,payload:{run_id}});
    }catch{wake='unknown';}
    return {run_id,step_id,published_version_id,decision:recorded.decision,
      recorded:true,wake,dispatch_confirmed:false};
  }
  /** Cancel one approved physical Task/Session Step by server-pinned Run identity.
   * Parent business results and physical Session slots remain independent:
   * a 202 GitHub cancellation ACK is not evidence of terminal completion.
   */
  async cancel(run_id:string,step_id:string,force=false){
    assertId(run_id);assertId(step_id);
    // A reviewed child uses the same public cancel entrypoint, but it never
    // inherits the GitHub executor token or permits force cancellation.
    const planRow=await this.db.prepare(`SELECT v.plan FROM runs r
      JOIN workflow_versions v ON v.id=r.version_id WHERE r.id=?`)
      .bind(run_id).first<{plan:string}>();
    if(planRow){
      let published:Plan|null=null;
      try{published=JSON.parse(planRow.plan) as Plan;}catch{}
      // A waiting runtime approval has no physical GitHub Attempt yet.
      // Cancellation competes with the first approval decision through D1;
      // after the first Attempt, use physical GitHub cancellation/reconciliation.
      const approval=published?.steps.find(s=>s.id===step_id&&
        s.uses==='github.run'&&s.approval?.required===true);
      if(approval){
        // Repeated cancellation of an already-fenced approval is read-only.
        // A dispatched-but-unclaimed physical Job may still exist, so never
        // claim its termination or issue a second GitHub cancel POST.
        const prior=await this.db.prepare(`SELECT outcome,error_code FROM runs
          WHERE id=?`).bind(run_id)
          .first<{outcome:string;error_code:string|null}>();
        if(!force&&prior?.outcome==='cancelled'&&
           prior.error_code==='approval_cancel_requested'){
          const pending=await this.db.prepare(`SELECT 1 AS present FROM step_attempts
            WHERE run_id=? AND step_id=? LIMIT 1`)
            .bind(run_id,step_id).first<{present:number}>();
          return {run_id,step_id,cancellation:pending?'requested_unverified':'requested',
            physical_terminated:false};
        }
        const step=await this.db.prepare('SELECT status FROM run_steps WHERE run_id=? AND step_id=?')
          .bind(run_id,step_id).first<{status:string}>();
        if(step && (step.status==='waiting_approval'||step.status==='running')){
          if(force){
            // Force cancellation is only meaningful once a physical Attempt
            // exists; hand that case to the existing guarded GitHub path.
            const prior=await this.db.prepare(`SELECT 1 AS present FROM step_attempts
              WHERE run_id=? AND step_id=? LIMIT 1`)
              .bind(run_id,step_id).first<{present:number}>();
            if(!prior)throw new StateError('approval_force_not_supported');
          }else{
          // A recorded (even consumed) approval is not an external effect.
          // Race the FIRST GitHub Attempt using the same durable Run row:
          // cancellation wins before Attempt INSERT, or Attempt wins and
          // ordinary physical GitHub cancellation owns the request.
          const updates=await this.db.batch([
            this.db.prepare(`UPDATE runs SET outcome='cancelled',
              error_code='approval_cancel_requested',updated_at=?
              WHERE id=? AND outcome='running'
              AND EXISTS(SELECT 1 FROM run_steps s WHERE s.run_id=runs.id
                AND s.step_id=? AND s.status IN ('waiting_approval','running'))
              AND NOT EXISTS(SELECT 1 FROM step_attempts a WHERE a.run_id=runs.id
                AND a.step_id=?)
              AND NOT EXISTS(SELECT 1 FROM run_steps s WHERE s.run_id=runs.id
                AND s.step_id<>? AND s.status IN ('running','waiting','waiting_approval'))`)
              .bind(now(),run_id,step_id,step_id,step_id),
            this.db.prepare(`UPDATE run_steps SET status='cancelled',
              error_code='approval_cancel_requested',updated_at=?
              WHERE run_id=? AND step_id=? AND status IN ('waiting_approval','running')
                AND EXISTS(SELECT 1 FROM runs WHERE id=?
                  AND outcome='cancelled' AND error_code='approval_cancel_requested')`)
              .bind(now(),run_id,step_id,run_id),
          ]);
          if(updates[0].meta.changes===1&&updates[1].meta.changes===1){
            // Session quota can be reserved immediately before Attempt INSERT.
            // Its never-dispatched slot is safe to release after the Run CAS.
            if((approval.with.action as {type?:unknown}|undefined)?.type==='session'){
              try{await releaseNeverDispatchedSessionSlot(this.db,run_id,step_id,now());}
              catch{/* Cancellation is already durable; do not claim slot release. */}
            }
            let wake:'sent'|'unknown'='sent';
            try{
              const row=await this.db.prepare('SELECT instance_id FROM runs WHERE id=?')
                .bind(run_id).first<{instance_id:string}>();
              if(!row)throw Error('run_missing');
              const native=await this.env.WORKFLOW.get(row.instance_id);
              if(!native.sendEvent)throw Error('send_event_unavailable');
              await native.sendEvent({type:'approval-'+step_id,payload:{run_id}});
            }catch{wake='unknown';}
            return {run_id,step_id,cancellation:'requested',wake,physical_terminated:false};
          }
          // If physical dispatch already reserved an Attempt, do not silently
          // give up cancellation: fall through to GitHub terminal reconciliation.
          const attempt=await this.db.prepare(`SELECT 1 AS present FROM step_attempts
            WHERE run_id=? AND step_id=? LIMIT 1`)
            .bind(run_id,step_id).first<{present:number}>();
          if(!attempt)throw new StateError('approval_cancel_conflict');
          // The Attempt INSERT can win while its outbound GitHub dispatch
          // has not yet returned a physical Run ID. Refusing cancellation
          // here leaves an approved Task able to claim and execute.
          // Fence the business Run before the signed physical Claim instead;
          // an in-flight dispatch is NOT proof of physical termination.
          const preclaim=await this.db.batch([
            this.db.prepare(`UPDATE runs SET outcome='cancelled',
              error_code='approval_cancel_requested',updated_at=?
              WHERE id=? AND outcome='running'
              AND EXISTS(SELECT 1 FROM step_attempts a
                WHERE a.run_id=runs.id AND a.step_id=?
                  AND a.capability_id='github.action'
                  AND a.state IN ('created','dispatch_unknown')
                  AND a.candidate_run_id IS NULL AND a.candidate_run_attempt IS NULL
                  AND a.owner_run_id IS NULL AND a.owner_run_attempt IS NULL)
              AND NOT EXISTS(SELECT 1 FROM run_steps s WHERE s.run_id=runs.id
                AND s.step_id<>? AND s.status IN ('running','waiting','waiting_approval'))`)
              .bind(now(),run_id,step_id,step_id),
            this.db.prepare(`UPDATE run_steps SET status='cancelled',
              error_code='approval_cancel_requested',updated_at=?
              WHERE run_id=? AND step_id=? AND status IN ('waiting_approval','running')
                AND EXISTS(SELECT 1 FROM runs r WHERE r.id=?
                  AND r.outcome='cancelled' AND r.error_code='approval_cancel_requested')`)
              .bind(now(),run_id,step_id,run_id),
          ]);
          if(preclaim[0].meta.changes===1){
            if(preclaim[1].meta.changes!==1)
              throw new StateError('approval_cancel_state_unconfirmed');
            return {run_id,step_id,cancellation:'requested_unverified',
              physical_terminated:false};
          }
          // A signed Claim or confirmed candidate may have won instead;
          // use the existing immutable physical Job cancellation path.
          }
        }
      }
      const cloudflare=published?.steps.find(s=>s.id===step_id&&s.uses==='action.run');
      if(cloudflare){
        if(force)throw new StateError('cloudflare_force_not_supported');
        // Both cancellation and first dispatch compete on D1 durable rows.
        // After reservation we cannot promise that an external send is revoked.
        await this.db.prepare(`INSERT OR IGNORE INTO cloudflare_action_cancellations
          (run_id,step_id,created_at) SELECT ?,?,? FROM runs
          WHERE id=? AND outcome IN ('queued','running')`)
          .bind(run_id,step_id,now(),run_id).run();
        const reserved=await this.db.prepare(`SELECT 1 AS present FROM cloudflare_action_invocations
          WHERE run_id=? AND step_id=?`).bind(run_id,step_id)
          .first<{present:number}>();
        if(!reserved){
          await this.db.prepare(`UPDATE runs SET outcome='cancelled',
            error_code='cloudflare_action_cancel_requested',updated_at=?
            WHERE id=? AND outcome IN ('queued','running')
            AND NOT EXISTS(SELECT 1 FROM cloudflare_action_invocations
              WHERE run_id=? AND step_id=?)`)
            .bind(now(),run_id,run_id,step_id).run();
        }
        return {run_id,step_id,cancellation:reserved?'dispatched_may_complete':'requested',
          physical_terminated:false};
      }
      const child=published?.steps.find(s=>s.id===step_id&&s.uses==='flow.child');
      const waiting=published?.steps.find(s=>s.id===step_id&&s.uses==='flow.wait_event');
      if(waiting){
        if(force)throw new StateError('wait_event_force_not_supported');
        const row=await this.db.prepare('SELECT instance_id,outcome,error_code FROM runs WHERE id=?')
          .bind(run_id).first<{instance_id:string;outcome:string;error_code:string|null}>();
        if(!row)throw new StateError('run_not_found');
        // This entrypoint cancels *an actively waiting event Step*, not any
        // Run which happens to contain one. Never terminate a Run after the
        // event resumed or while another independent Step is still active.
        if(row.outcome==='cancelled'){
          if(row.error_code!=='event_wait_cancel_requested')
            throw new StateError('wait_event_not_cancellable');
        }else{
          const updated=await this.db.prepare(`UPDATE runs SET outcome='cancelled',
            error_code='event_wait_cancel_requested',updated_at=?
            WHERE id=? AND outcome='running'
            AND EXISTS (SELECT 1 FROM run_steps s
              WHERE s.run_id=runs.id AND s.step_id=? AND s.status='waiting')
            AND NOT EXISTS (SELECT 1 FROM run_steps s
              WHERE s.run_id=runs.id AND s.step_id<>?
                AND s.status IN ('running','waiting'))`)
            .bind(now(),run_id,step_id,step_id).run();
          if(!updated.meta.changes)
            throw new StateError('wait_event_not_cancellable');
        }
        await this.db.prepare(`UPDATE run_steps SET status='cancelled',
          error_code='event_wait_cancel_requested',updated_at=?
          WHERE run_id=? AND step_id=? AND status='waiting'`)
          .bind(now(),run_id,step_id).run();
        // D1 cancellation is the durable business-effect fence. Native
        // terminate is best effort and must be independently observed.
        let nativeTerminated=false;
        try{
          const instance=await this.env.WORKFLOW.get(row.instance_id);
          if(instance.terminate)await instance.terminate(published?.saga?.on.includes('cancel')?{rollback:true}:undefined);
          nativeTerminated=(await instance.status()).status==='terminated';
        }catch{}
        // Native terminate({rollback:true}) can settle with RollbackMissing:
        // registered handlers are then not executed. Do not infer success
        // from the native termination ACK. Reuse the exact D1-fenced,
        // independently authorized GitHub compensation path; native and
        // fallback requests share the same receipt and cannot double POST.
        if(published?.saga?.on.includes('cancel'))
          await compensateCancelledSessions(this.env,published,run_id);
        return {run_id,step_id,cancellation:nativeTerminated?'terminal_confirmed':'requested',
          native_workflow_terminated:nativeTerminated,
          // A Cloudflare termination never proves external GitHub resources
          // or other concurrently executing side effects have stopped.
          physical_terminated:false};
      }
      if(child){
        if(force)throw new StateError('child_force_not_supported');
        const state=await cancelAwaitedChild(this.env,run_id,step_id);
        if(state==='not_found')throw new StateError('child_not_cancellable');
        return {run_id,step_id,cancellation:state,
          native_workflow_terminated:state==='terminal_confirmed',
          // Cloudflare termination is NOT proof that a GitHub Session or
          // other external resource has physically stopped.
          physical_terminated:false};
      }
    }
    if(!this.env.WORKFLOW_GITHUB_DISPATCH_TOKEN)
      throw new StateError('github_action_executor_not_configured');
    const cancellation=await requestGitHubActionCancellation(
      this.db,run_id,step_id,this.env.WORKFLOW_GITHUB_DISPATCH_TOKEN,force);
    if(cancellation==='not_found')throw new StateError('github_action_not_cancellable');
    return {run_id,step_id,cancellation,
      physical_terminated:cancellation==='terminal_confirmed'};
  }
  async pause(workflow_id:string){assertId(workflow_id);const x=await this.db.prepare("UPDATE workflows SET state='paused',updated_at=? WHERE id=? AND state='active' AND deleted_at IS NULL").bind(now(),workflow_id).run();if(!x.meta.changes)throw new StateError('not_active');return {workflow_id,state:'paused'};}
  async resume(workflow_id:string){assertId(workflow_id);const x=await this.db.prepare("UPDATE workflows SET state='active',updated_at=? WHERE id=? AND state='paused' AND active_version_id IS NOT NULL AND deleted_at IS NULL").bind(now(),workflow_id).run();if(!x.meta.changes)throw new StateError('not_paused');return {workflow_id,state:'active'};}

  /** Non-destructive tombstone: retain published Versions, Runs and receipts.
   * Atomic predicate fences admission/Session/parent references at commit. */
  async delete(workflow_id:string,expected_revision:number){
    assertId(workflow_id);
    if(!Number.isSafeInteger(expected_revision)||expected_revision<1)
      throw new StateError('invalid_revision');
    const time=now();
    const result=await this.db.prepare(`UPDATE workflows
      SET deleted_at=?,state='paused',updated_at=?
      WHERE id=? AND draft_revision=? AND deleted_at IS NULL
        AND state IN ('draft','paused')
        AND NOT EXISTS (
          SELECT 1 FROM runs r WHERE r.workflow_id=workflows.id
            AND (r.outcome IN ('queued','running') OR r.start_state IN ('reserved','start_unknown'))
        )
        AND NOT EXISTS (
          SELECT 1 FROM session_executions s
          JOIN runs r ON r.id=s.run_id
          WHERE r.workflow_id=workflows.id AND s.state!='terminated'
        )
        AND NOT EXISTS (
          SELECT 1 FROM workflows parent
          JOIN workflow_versions v ON v.id=parent.active_version_id
          JOIN json_each(v.plan,'$.child_approvals') child
          WHERE parent.id!=workflows.id AND parent.deleted_at IS NULL
            AND parent.state IN ('active','paused')
            AND json_extract(child.value,'$.workflow_id')=workflows.id
        )`).bind(time,time,workflow_id,expected_revision).run();
    if(result.meta.changes)
      return {workflow_id,state:'deleted' as const,history_preserved:true};
    const row=await this.db.prepare('SELECT state,draft_revision,deleted_at FROM workflows WHERE id=?')
      .bind(workflow_id).first<Pick<WorkflowRow,'state'|'draft_revision'|'deleted_at'>>();
    if(!row)throw new StateError('workflow_not_found');
    if(row.deleted_at!==null)
      return {workflow_id,state:'deleted' as const,already_deleted:true,history_preserved:true};
    if(row.draft_revision!==expected_revision)throw new StateError('revision_conflict');
    if(!['draft','paused'].includes(row.state))throw new StateError('workflow_not_paused');
    const busy=await this.db.prepare(`SELECT 1 AS present FROM runs
      WHERE workflow_id=? AND (outcome IN ('queued','running')
        OR start_state IN ('reserved','start_unknown')) LIMIT 1`)
      .bind(workflow_id).first<{present:number}>();
    if(busy)throw new StateError('workflow_has_unsettled_runs');
    const session=await this.db.prepare(`SELECT 1 AS present FROM session_executions s
      JOIN runs r ON r.id=s.run_id WHERE r.workflow_id=? AND s.state!='terminated' LIMIT 1`)
      .bind(workflow_id).first<{present:number}>();
    if(session)throw new StateError('workflow_has_active_sessions');
    const parent=await this.db.prepare(`SELECT 1 AS present FROM workflows parent
      JOIN workflow_versions v ON v.id=parent.active_version_id
      JOIN json_each(v.plan,'$.child_approvals') child
      WHERE parent.id!=? AND parent.deleted_at IS NULL
        AND parent.state IN ('active','paused')
        AND json_extract(child.value,'$.workflow_id')=? LIMIT 1`)
      .bind(workflow_id,workflow_id).first<{present:number}>();
    if(parent)throw new StateError('workflow_referenced_by_parent');
    throw new StateError('workflow_delete_conflict');
  }
  async start(workflow_id:string,inputs:Record<string,unknown>={},idempotency_key?:string,expected_version_id?:string,allowTransientFile=false){
    assertId(workflow_id);if(idempotency_key!==undefined&&(idempotency_key.length>128||!safeId(idempotency_key)))throw new StateError('invalid_idempotency_key');
    // The platform's minute identity cannot be impersonated by manual callers.
    if((idempotency_key?.startsWith('cron-')||idempotency_key?.startsWith('webhook-')||idempotency_key?.startsWith('github-event-'))&&!expected_version_id)
      throw new StateError('reserved_idempotency_key');
    let inputJson=json(inputs);
    let request_digest=await digest(canonicalJsonString(inputs));
    // An accepted admission keeps its pinned version across republish/pause.
    if(idempotency_key){
      const original=await this.db.prepare('SELECT * FROM runs WHERE workflow_id=? AND admission_key=?').bind(workflow_id,idempotency_key).first<RunRow>();
      if(original){
        if(allowTransientFile)throw new StateError('litterbox_duplicate_admission');
        // A normal workflow_run cannot use a prior file upload Run's key
        // to circumvent the selected-file tool gate, even on replay.
        const oldPlan=await this.db.prepare('SELECT plan FROM workflow_versions WHERE id=?')
          .bind(original.version_id).first<{plan:string}>();
        if(!oldPlan)throw new StateError('published_version_missing');
        let parsed:Plan;
        try{parsed=JSON.parse(oldPlan.plan) as Plan;}catch{throw new StateError('published_plan_invalid');}
        if(parsed.steps?.some(s=>s.uses==='action.run'&&s.with.provider==='litterbox'))
          throw new StateError('litterbox_file_tool_required');if((JSON.parse(original.inputs) as Record<string,unknown>).key_digest)throw new StateError('envshare_key_unrecoverable');if(original.request_digest!==request_digest)throw new StateError('idempotency_conflict');if(expected_version_id&&original.version_id!==expected_version_id)throw new StateError('published_version_changed');return this.reconcileStart(original);}
    }
    // Reconcile only the bounded number of stale starts occupying the eight
    // Workflow admission slots. This is ingress repair, not a new scheduler.
    const stale=await this.db.prepare("SELECT * FROM runs WHERE parent_run_id IS NULL AND outcome='queued' AND start_state IN ('reserved','start_unknown') AND created_at<=? ORDER BY created_at ASC LIMIT 8")
      .bind(now()-START_RECONCILE_WINDOW_MS).all<RunRow>();
    for(const old of stale.results)await this.reconcileStart(old);
    // When all eight slots are occupied, bounded ingress repair also checks
    // started Workflows whose native engine completed but D1 never finalized.
    const capacity=await this.db.prepare(`SELECT ${ACTIVE_CAPACITY_UNITS_SQL} AS count`).first<{count:number}>();
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
    if(expected_version_id&&expected_version_id!==version)throw new StateError('published_version_changed');
    // Reject unsupported Action execution before reserving any durable Run
    // slot. Publication permits owner review, not dispatch authorization.
    const published=await this.db.prepare('SELECT plan FROM workflow_versions WHERE id=? AND workflow_id=?')
      .bind(version,workflow_id).first<{plan:string}>();
    if(!published)throw new StateError('published_version_missing');
    let activePlan:Plan;
    try{activePlan=JSON.parse(published.plan) as Plan;}
    catch{throw new StateError('published_plan_invalid');}
    if(!Array.isArray(activePlan.steps))throw new StateError('published_plan_invalid');
    // Reject invalid/unapproved runtime overrides before reserving a Run.
    // A legacy literal Session Plan remains immutable and must not pretend
    // that a supplied duration was honored.
    if(Object.hasOwn(inputs,'duration_minutes')){
      const sessions=activePlan.steps.filter(s=>s.uses==='github.run'&&
        (s.with.action as {type?:unknown}|undefined)?.type==='session');
      if(sessions.length&&!sessions.every(s=>isSessionDurationInputRef(
        (s.with.action as {inputs?:Record<string,unknown>}).inputs?.duration_minutes)))
        throw new StateError('session_duration_override_not_enabled');
      if(sessions.length&&(!Number.isSafeInteger(inputs.duration_minutes)||
         Number(inputs.duration_minutes)<1||Number(inputs.duration_minutes)>300))
        throw new StateError('github_action_invalid_duration');
    }

    // Secret never reaches durable D1 inputs, Action outputs or ordinary result.
    // Litterbox bytes and signed file locator are never durable Run inputs.
    // Only the selected-file MCP tool may start this manual-only Plan.
    const isLitterbox=activePlan.steps.length===1&&
      activePlan.steps[0]?.uses==='action.run'&&
      activePlan.steps[0].with.provider==='litterbox'&&
      activePlan.steps[0].with.action==='litterbox.upload_file';
    if(isLitterbox!==allowTransientFile)throw new StateError('litterbox_file_tool_required');
    if(isLitterbox&&(!idempotency_key||expected_version_id||
      activePlan.cloudflare_execution_approved!==true||activePlan.triggers?.length))
      throw new StateError('litterbox_manual_approval_required');
    let deliveryKey:string|undefined;
    if(isEnvsharePlan(activePlan)){
      if(expected_version_id||!idempotency_key||activePlan.triggers?.length||
         activePlan.cloudflare_execution_approved!==true)
        throw new StateError('envshare_manual_approval_required');
      const sealed=await encryptEnvshareAdmission(inputs);
      inputJson=json(sealed.inputs);
      request_digest=sealed.request_digest;
      deliveryKey=sealed.delivery_key;
    }
    const protocolActions=activePlan.steps.filter(step=>
      step.uses==='github.run'&&step.with?.capability==='github.action');
    // Session uses the same reviewed GitHub Action admission as Task.
    // A Session's physical capacity is reserved atomically (max 4) by its
    // durable Runner step BEFORE dispatch; admission here only reserves the
    // normal Workflow Run slot, and never grants an extra physical Session.
    if(protocolActions.some(step=>!['task','session'].includes(
       String((step.with.action as {type?:unknown}|undefined)?.type))))
      throw new StateError('github_action_invalid_publication');
    if(protocolActions.length &&
       (!this.env.WORKFLOW_GITHUB_DISPATCH_TOKEN||!this.env.GITHUB_ACTION_OIDC_AUDIENCE))
      throw new StateError('github_action_executor_not_configured');
    const hasChild=activePlan.steps.some(s=>s.uses==='flow.child');
    const weight=activePlan.steps.some(s=>s.uses==='flow.child'&&s.with.mode!=='detached')?2:1;
    if(hasChild&&(!activePlan.child_approvals||activePlan.child_approvals.length!==1))
      throw new StateError('child_approval_required');
    const id=crypto.randomUUID(),t=now();
    const insert=await this.db.prepare(
      `INSERT OR IGNORE INTO runs(id,workflow_id,version_id,instance_id,admission_key,request_digest,inputs,start_state,outcome,created_at,updated_at,capacity_weight) SELECT ?,?,?,?,?,?,?, 'reserved','queued',?,?,? WHERE EXISTS (SELECT 1 FROM workflows WHERE id=? AND state='active' AND deleted_at IS NULL AND active_version_id=?) AND ${capacityAdmissionPredicate(weight as 1|2)}`
    ).bind(id,workflow_id,version,id,idempotency_key??null,request_digest,inputJson,t,t,weight,workflow_id,version).run();
    if(!insert.meta.changes){
      if(idempotency_key){const prior=await this.db.prepare('SELECT * FROM runs WHERE workflow_id=? AND admission_key=?').bind(workflow_id,idempotency_key).first<RunRow>();
        if(prior){if(allowTransientFile)throw new StateError('litterbox_duplicate_admission');if(deliveryKey)throw new StateError('envshare_key_unrecoverable');if(prior.request_digest!==request_digest)throw new StateError('idempotency_conflict');if(expected_version_id&&prior.version_id!==expected_version_id)throw new StateError('published_version_changed');return this.reconcileStart(prior);}}
      const latest=await this.row(workflow_id);
      if(latest.state!=='active')throw new StateError('workflow_not_active');
      if(latest.active_version_id!==version)throw new StateError('published_version_changed');
      throw new StateError('run_capacity_exceeded');
    }
    try{await this.env.WORKFLOW.create({id,params:{run_id:id}});await this.db.prepare("UPDATE runs SET start_state='started',updated_at=? WHERE id=? AND start_state IN ('reserved','start_unknown')").bind(now(),id).run();return {run_id:id,published_version_id:version,status:'queued',start_state:'started',...(deliveryKey?{delivery_key:deliveryKey}:{})};}
    catch {
      await this.db.prepare("UPDATE runs SET start_state='start_unknown',updated_at=? WHERE id=? AND start_state='reserved'").bind(now(),id).run();
      const prior=await this.db.prepare('SELECT * FROM runs WHERE id=?').bind(id).first<RunRow>();
      const ack=await this.reconcileStart(prior!);return {...ack,...(deliveryKey?{delivery_key:deliveryKey}:{})};
    }
  }
  private async reconcileStart(row:RunRow){
    if(row.parent_run_id)throw new StateError('child_start_requires_parent');
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
      if(!row.parent_run_id)await this.reconcileStart(row);
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
    const stored=(await this.db.prepare('SELECT step_id,status,error_code FROM run_steps WHERE run_id=? ORDER BY step_id').bind(run_id).all<{step_id:string;status:string;error_code:string|null}>()).results;
    const version=await this.db.prepare('SELECT plan FROM workflow_versions WHERE id=?').bind(row.version_id).first<{plan:string}>();
    if(!version)throw new StateError('version_missing');
    const terminal=['succeeded','failed','indeterminate','cancelled'].includes(row.outcome)||native==='complete';
    const byId=new Map(stored.map(s=>[s.step_id,s]));
    const publishedPlan=JSON.parse(version.plan) as Plan;
    const dynamicIds=new Set(publishedPlan.steps.flatMap(s=>{
      if(s.uses!=='flow.foreach')return [];
      const templates=(Array.isArray(s.with.templates)?s.with.templates:[s.with.template]) as
        Array<{id?:unknown}|undefined>;
      const count=s.with.max_items;
      if(!Number.isSafeInteger(count)||Number(count)<1||Number(count)>8||
         !templates.length||templates.length>4||
         templates.some(template=>typeof template?.id!=='string'))return [];
      return Array.from({length:count as number},(_,index)=>
        templates.map(template=>s.id+'_'+index+'_'+template!.id)).flat();
    }));
    const steps=[
      ...publishedPlan.steps.map(s=>{
        const saved=byId.get(s.id);
        if(saved && ['succeeded','failed','skipped','indeterminate','cancelled'].includes(saved.status))return saved;
        return {step_id:s.id,status:terminal?'indeterminate':saved?.status??'waiting',error_code:saved?.error_code??null};
      }),
      ...stored.filter(s=>dynamicIds.has(s.step_id)).map(saved=>
        terminal&&!['succeeded','failed','skipped','indeterminate'].includes(saved.status)
          ?{...saved,status:'indeterminate'}:saved),
    ].sort((a,b)=>a.step_id<b.step_id?-1:a.step_id>b.step_id?1:0);
    // A Session may remain live after the parent Workflow succeeds at Ready.
    // Expose its last durable state independently without calling it "online":
    // the GitHub physical health is not live-verified by this D1 snapshot.
    const hasSessions=publishedPlan.steps.some(s=>
      s.uses==='github.run'&&s.with.capability==='github.action'&&
      (s.with.action as {type?:unknown}|undefined)?.type==='session');
    if(hasSessions&&this.env.WORKFLOW_GITHUB_DISPATCH_TOKEN){
      // Status/Result are reconciliatory tools. A completed parent cannot
      // mask its still-running physical Session, and API outages cannot free
      // a slot. At most four active Sessions exist globally.
      const active=(await this.db.prepare(`SELECT s.step_id,a.attempt_id
        FROM session_executions s
        LEFT JOIN step_attempts a ON a.run_id=s.run_id AND a.step_id=s.step_id
        WHERE s.run_id=? AND s.state!='terminated' ORDER BY s.step_id LIMIT 4`)
        .bind(run_id).all<{step_id:string;attempt_id:string|null}>()).results;
      for(const session of active){
        if(!session.attempt_id)continue;
        try{
          await reconcilePersistedGitHubActionAttempt(
            this.db,session.attempt_id,this.env.WORKFLOW_GITHUB_DISPATCH_TOKEN);
          await releaseVerifiedSessionSlot(this.db,run_id,session.step_id);
        }catch{
          // GitHub API unknown never means terminal or capacity released.
        }
      }
    }
    // A web Quick Tunnel Session has no Tailnet hostname. Never advertise a
    // guessed MagicDNS host for it just because its GitHub job became Ready.
    const tailnetSteps=new Map<string,string>(publishedPlan.steps.flatMap(step=>{
      if(step.uses!=='github.run'||step.with.capability!=='github.action')return [];
      const action=step.with.action as {repository?:unknown;workflowPath?:unknown}|undefined;
      if(action?.repository!=='lirtual/github-actions')return [];
      const name=action.workflowPath==='.github/workflows/windows.yml'?'session-windows':
        action.workflowPath==='.github/workflows/ubuntu.yml'?'session-ubuntu':null;
      return name?[[step.id,name] as [string,string]]:[];
    }));
    const sessions=hasSessions?(await this.db.prepare(`SELECT s.step_id,s.state,s.session_url,s.fixed_key,
      s.updated_at,a.candidate_run_id,a.candidate_run_attempt,a.state AS attempt_state
      FROM session_executions s
      LEFT JOIN step_attempts a ON a.run_id=s.run_id AND a.step_id=s.step_id
      WHERE s.run_id=? ORDER BY s.step_id`).bind(run_id)
      .all<{step_id:string;state:string;session_url:string|null;fixed_key:string|null;updated_at:number;candidate_run_id:number|null;candidate_run_attempt:number|null;attempt_state:string|null}>()).results
      .map(record=>({step_id:record.step_id,session_mode:record.fixed_key?'fixed':'temporary',
        recorded_state:record.state,
        recorded_at:record.updated_at,
        session_url:record.state==='ready'?record.session_url:null,
        github_run_id:record.candidate_run_id,
        github_run_attempt:record.candidate_run_attempt,
        // The pinned Runner validates the exact MagicDNS name before signed Ready.
        // This locator is not proof of physical connectivity.
        private_hostname:record.state==='ready' && tailnetSteps.has(record.step_id) &&
          Number.isSafeInteger(record.candidate_run_id) &&
          (record.candidate_run_id??0)>0
          && Number.isSafeInteger(record.candidate_run_attempt)
          && (record.candidate_run_attempt??0)>0
          ?(record.fixed_key!==null?tailnetSteps.get(record.step_id)??null:
            'sa-'+record.candidate_run_id+'-a'+record.candidate_run_attempt):null,
        attempt_state:record.attempt_state,
        physical_health:record.state==='terminated'?'terminated':'unverified'})):[];
    // The Session terminal state is written only after physical GitHub
    // confirmation. Repair the request-only Saga receipt after that proof,
    // without inferring physical cleanup from a native rollback ACK.
    if(publishedPlan.saga)for(const step of publishedPlan.steps){
      if(!step.compensate)continue;
      const receipt=byId.get('__saga_'+step.id);
      if(receipt?.status!=='requested')continue;
      const updated=await this.db.prepare(`UPDATE run_steps
        SET status='succeeded',updated_at=?
        WHERE run_id=? AND step_id=? AND status='requested'
        AND EXISTS(SELECT 1 FROM session_executions session
          JOIN step_attempts attempt ON attempt.run_id=session.run_id
            AND attempt.step_id=session.step_id
            AND attempt.capability_id='github.action'
          WHERE session.run_id=run_steps.run_id AND session.step_id=?
            AND session.state='terminated'
            AND attempt.state IN ('succeeded','failed','cancelled'))`)
        .bind(now(),run_id,'__saga_'+step.id,step.id).run();
      if(updated.meta.changes===1)receipt.status='succeeded';
    }
    const saga=publishedPlan.saga?(()=>{
      const triggered=(row.outcome==='cancelled'&&publishedPlan.saga!.on.includes('cancel'))||
        (['failed','indeterminate'].includes(row.outcome)&&publishedPlan.saga!.on.includes('failure'));
      const compensations=publishedPlan.steps.filter(s=>s.compensate).map(s=>{
        const prior=byId.get('__saga_'+s.id);
        const session=sessions.find(record=>record.step_id===s.id);
        const physicalTerminated=session?.recorded_state==='terminated';
        const confirmed=prior?.status==='succeeded'||(
          prior?.status==='requested'&&physicalTerminated);
        const status=confirmed?'succeeded':prior?.status??(
          triggered&&byId.get(s.id)?.status==='succeeded'?'unconfirmed':'not_required');
        return {step_id:s.id,kind:s.compensate!.kind,status,
          // Report verified physical termination independently of how it
          // happened; a manually cancelled Session is not Saga success.
          physical_terminated:physicalTerminated||confirmed};
      });
      return {on:publishedPlan.saga!.on,acid_rollback:false,
        status:!triggered?'not_triggered':
          compensations.some(x=>['requested','indeterminate','unconfirmed','running'].includes(x.status))?
            'incomplete':compensations.some(x=>x.status==='uncleared')?'partial':
            'settled',
        compensations};
    })():null;
    return {run_id,workflow_id:row.workflow_id,published_version_id:row.version_id,start_state:row.start_state,status:['succeeded','failed','indeterminate','cancelled'].includes(row.outcome)?row.outcome:row.start_state!=='started'?'start_unknown':applyStatus(native,row.outcome),steps,...(hasSessions?{sessions}:{}),...(saga?{saga}:{})};
  }
  async result(run_id:string,delivery_key?:string){
    const meta=await this.status(run_id);
    const row=await this.db.prepare('SELECT result,error_code FROM runs WHERE id=?').bind(run_id).first<{result:string|null;error_code:string|null}>();
    const artifactReferences=await workflowGitHubArtifactReferences(
      this.db,run_id,this.env.WORKFLOW_GITHUB_DISPATCH_TOKEN);
    let share_url:string|undefined;
    if(delivery_key!==undefined){
      if(meta.status!=='succeeded')throw new StateError('envshare_result_unavailable');
      const saved=await this.db.prepare(`SELECT r.inputs,v.plan FROM runs r
        JOIN workflow_versions v ON v.id=r.version_id WHERE r.id=?`)
        .bind(run_id).first<{inputs:string;plan:string}>();
      if(!saved||!isEnvsharePlan(JSON.parse(saved.plan) as Plan))
        throw new StateError('envshare_not_available');
      const result=row?.result?JSON.parse(row.result) as Record<string,unknown>:null;
      if(result?.status!=='accepted')throw new StateError('envshare_result_unavailable');
      share_url=await buildEnvshareLink(saved?JSON.parse(saved.inputs):null,result.share_id,delivery_key);
    }
    return limitResult({...meta,result:row?.result?JSON.parse(row.result):null,
      ...(share_url?{share_url}:{}),
      ...(artifactReferences.length?{artifact_references:artifactReferences}:{}),
      error_code:row?.error_code??null},64*1024);
  }
}
