import YAML from 'yaml';
import {httpOperation,type HttpOperation} from './http-action.ts';
import {cloudflareActionManifest} from './cloudflare-action-contract.ts';
import {parseUtcCron, type CronTrigger} from './cron.ts';
import { publicMcpEndpoint } from './mcp-public-fetch.ts';
import {reviewedWriteArguments} from './mcp-write-contract.ts';
import {isForeachTaskInputRef,isSessionDurationInputRef} from './github-action-inputs.ts';
import type {DiscoveredAction} from './github-action-contract.ts';

/** Compiler-owned supported Action kinds; discovery must not invent others. */
export const SUPPORTED_STEP_USES = ['result.emit','mcp.call','github.run','action.run','http.request'] as const;
export const PLAN_LIMITS = Object.freeze({definitionBytes:32768,maxSteps:32,maxInputs:32,maxParallel:8,maxRepeat:8,maxForeachItems:8,maxForeachTemplateSteps:4,maxWaitSeconds:300,maxEventWaitSeconds:3600});
export function isSupportedStepUse(value:unknown):value is (typeof SUPPORTED_STEP_USES)[number]{
  return typeof value==='string' && (SUPPORTED_STEP_USES as readonly string[]).includes(value);
}

export class PlanError extends Error {
  code = 'invalid_definition';
  path: string;
  constructor(message: string, path = '/') { super(message); this.name = 'PlanError'; this.path = path; }
}
export type Step = {
  id: string; uses: 'result.emit' | 'mcp.call' | 'github.run' | 'action.run' | 'http.request' | 'flow.foreach' | 'flow.child' | 'flow.wait' | 'flow.wait_event' | 'flow.loop'; needs: string[];
  needs_policy?: 'allow_skipped';
  with: Record<string, unknown>; if?: unknown; approval?: {required:true};
  compensate?: {kind:'github.session.cancel'};
};
export type ReadonlyOperation = { endpoint:string; tool:string; scope:'read'|'write'; schema_digest:string };
export type WebhookTrigger = {type:'webhook';token_sha256:string};
export type GithubEventTrigger = {type:'github_event';repository:string;repository_id:number;event:'push';ref:string;workflow_path:string};
export const GITHUB_EVENT_PATTERNS=Object.freeze({
  repository:/^(?!.*\.\.)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
  ref:/^refs\/heads\/(?!.*(?:\.\.|\/\/|\/$))[A-Za-z0-9][A-Za-z0-9._\/-]{0,119}$/,
  workflow_path:/^\.github\/workflows\/(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9_.-]{0,100}\.ya?ml$/,
});
export type WorkflowTrigger = CronTrigger | WebhookTrigger | GithubEventTrigger;
export type Plan = { version: 1; name: string; steps: Step[]; saga?:{on:('failure'|'cancel')[]}; saga_compensation_approved?:true; inputs?: Record<string, unknown>; triggers?: WorkflowTrigger[]; mcp_approvals?: ReadonlyOperation[]; mcp_target_risks_accepted?: true; mcp_write_execution_approved?:true; mcp_connection_generation?: number; http_approvals?:HttpOperation[]; http_execution_approved?:true; http_connection_generation?:number; github_execution_approved?: true; cloudflare_execution_approved?: true; cloudflare_action_approvals?:Array<{executor:'cloudflare';provider:string;action:string;contract_digest:string;deployment_id:string}>;  github_action_approvals?: Array<{repository:string;repositoryId:number;workflowId:number;workflowPath:string;commitSha:string;type:'task'|'session';contractDigest:string}>; github_dynamic_input_contracts?:Record<string,DiscoveredAction>; child_approvals?:Array<{workflow_id:string;version_id:string;digest:string}> };
const SAFE_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OBJECT_PROTOTYPE_KEYS = new Set(['constructor','toString','toLocaleString','valueOf','hasOwnProperty','isPrototypeOf','propertyIsEnumerable']);
const RESERVED = new Set(['eval','javascript','script','code','shell','endpoint','url','command','function']);
const KNOWN_UNSUPPORTED_FIELDS = new Set([
  'saga','repeat','expand','approval','foreach','while',
  'child','child_workflow','wait','sleep','delay','steps',
]);
const keys = (o: Record<string, unknown>, allowed: string[], basePath = '/') => {
  for (const key of Object.keys(o)) if (!allowed.includes(key)) {
    // Keep arbitrary user-supplied keys out of API paths and messages.
    const path = KNOWN_UNSUPPORTED_FIELDS.has(key)
      ? (basePath === '/' ? '' : basePath) + '/' + key : basePath;
    throw new PlanError('unsupported_field:'+key,path);
  }
};
function object(value: unknown, message: string): Record<string, unknown> {
  if(!value || typeof value !== 'object' || Array.isArray(value)) throw new PlanError(message);
  return value as Record<string, unknown>;
}
function refCheck(ref: string, step?: {id:string;needs:string[]}, allowItem=false, path='/') {
  const parts=ref.split('.');
  if(parts.length<2 || parts.slice(1).some(p=>!SAFE_ID.test(p)||['__proto__','constructor','prototype'].includes(p))) throw new PlanError('invalid_reference',path);
  if(parts[0]==='inputs') return;
  if(allowItem&&parts[0]==='item'&&['value','index'].includes(parts[1])&&
     (parts[1]==='value'||parts.length===2))return;
  if(parts[0]==='steps' && step && step.needs.includes(parts[1]) && parts.length>=3 && ['status','output'].includes(parts[2])) return;
  throw new PlanError('invalid_step_reference',path);
}
function expression(v: unknown, step?: {id:string; needs:string[]}, depth=0, opaqueKeys=false, allowItem=false, path='/'): void {
  if(depth>15) throw new PlanError('expression_too_deep',path);
  if(v===null || typeof v==='string'||typeof v==='number'||typeof v==='boolean') return;
  if(Array.isArray(v)) { if(v.length>100) throw new PlanError('expression_too_large',path); for(const [index,x] of v.entries()) expression(x,step,depth+1,opaqueKeys,allowItem,path+'/'+index); return; }
  if(!v||typeof v!=='object')throw new PlanError('invalid_expression',path);
  const o=object(v,'invalid_expression');
  const names=Object.keys(o);
  if(names.length===1 && names[0]==='ref'){
    if(typeof o.ref!=='string') throw new PlanError('invalid_reference',path+'/ref');
    refCheck(o.ref,step,allowItem,path+'/ref');return;
  }
  if(names.length===1 && ['eq','ne','gt','lt','and','or','not'].includes(names[0])) {
    const op=names[0], arg=o[op];
    if(op==='not'){expression(arg,step,depth+1,opaqueKeys,allowItem,path+'/not');return;}
    if(!Array.isArray(arg)||arg.length<(op==='and'||op==='or'?1:2)||arg.length>(op==='and'||op==='or'?16:2))throw new PlanError('invalid_operator',path+'/'+op);
    for(const [index,x] of arg.entries())expression(x,step,depth+1,opaqueKeys,allowItem,path+'/'+op+'/'+index);
    return;
  }
  for(const [name,x] of Object.entries(o)){
    if(name==='__proto__'||name==='prototype'||name==='constructor')throw new PlanError('invalid_argument_key',path);
    if(!opaqueKeys&&RESERVED.has(name.toLowerCase()))throw new PlanError('unsafe_expression',path);
    // Arbitrary object keys may contain secrets; only include a known schema key in a public path.
    expression(x,step,depth+1,opaqueKeys,allowItem,
      ['data','arguments','inputs','notification'].includes(name)?path+'/'+name:path);
  }
}
// YAML accepts .nan/.inf, but JSON persistence silently changes them to null.
// Reject these before computing an immutable Published Plan digest.
function validateFiniteNumbers(v: unknown, depth=0): void {
  if(depth>32)throw new PlanError('definition_too_deep');
  if(typeof v==='number' && !Number.isFinite(v))throw new PlanError('non_finite_number');
  if(Array.isArray(v)) {for(const child of v)validateFiniteNumbers(child,depth+1);}
  else if(v && typeof v==='object') {
    for(const child of Object.values(v))validateFiniteNumbers(child,depth+1);
  }
}
function canonical(v: unknown): unknown {
  if(Array.isArray(v)) return v.map(canonical);
  if(v && typeof v==='object') return Object.fromEntries(Object.entries(v as Record<string,unknown>).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>[k,canonical(x)]));
  return v;
}
export function canonicalJsonString(value: unknown): string {
  return JSON.stringify(canonical(value));
}

// Bind an owner's reviewed MCP tool contract to a Published Plan. Key order
// is irrelevant; changes in either schema fail closed before tools/call.
export async function toolSchemaDigest(inputSchema:unknown, outputSchema?:unknown):Promise<string>{
  if(!inputSchema||typeof inputSchema!=='object'||Array.isArray(inputSchema)||
     (inputSchema as Record<string,unknown>).type!=='object'||
     (outputSchema!==undefined&&(!outputSchema||typeof outputSchema!=='object'||Array.isArray(outputSchema)||
       (outputSchema as Record<string,unknown>).type!=='object')))
    throw new PlanError('invalid_tool_schema');
  validateFiniteNumbers(inputSchema);
  if(outputSchema!==undefined)validateFiniteNumbers(outputSchema);
  const serial=canonicalJsonString({inputSchema,outputSchema:outputSchema??null});
  if(new TextEncoder().encode(serial).byteLength>8192)throw new PlanError('tool_schema_too_large');
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(serial));
  return [...new Uint8Array(hash)].map(v=>v.toString(16).padStart(2,'0')).join('');
}
export function evaluateExpression(v: unknown, ctx: {inputs:Record<string,unknown>;steps:Record<string,{status:string;output?:unknown}>;item?:{value:unknown;index:number}}): any {
  if(Array.isArray(v))return v.map(x=>evaluateExpression(x,ctx));
  if(v===null||typeof v!=='object')return v;
  const o=v as Record<string,unknown>;
  if(Object.keys(o).length===1){
    if('ref' in o) {let parts=String(o.ref).split('.');let value:any=parts[0]==='inputs'?ctx.inputs:parts[0]==='item'?ctx.item:parts[0]==='steps'?ctx.steps:undefined; for(const p of parts.slice(1)) {if(value===null||(typeof value!=='object'&&typeof value!=='function')||!Object.hasOwn(value,p))return undefined;value=value[p];}return value;}
    if('eq' in o) {const [a,b]=(o.eq as unknown[]).map(x=>evaluateExpression(x,ctx));return a===b;}
    if('ne' in o) {const [a,b]=(o.ne as unknown[]).map(x=>evaluateExpression(x,ctx));return a!==b;}
    if('gt' in o) {const [a,b]=(o.gt as unknown[]).map(x=>evaluateExpression(x,ctx));return typeof a==='number'&&typeof b==='number'&&a>b;}
    if('lt' in o) {const [a,b]=(o.lt as unknown[]).map(x=>evaluateExpression(x,ctx));return typeof a==='number'&&typeof b==='number'&&a<b;}
    if('and' in o)return (o.and as unknown[]).every(x=>evaluateCondition(x,ctx));
    if('or' in o)return (o.or as unknown[]).some(x=>evaluateCondition(x,ctx));
    if('not' in o)return !evaluateCondition(o.not,ctx);
  }
  return Object.fromEntries(Object.entries(o).map(([k,x])=>[k,evaluateExpression(x,ctx)]));
}
export function evaluateCondition(condition: unknown, ctx: {inputs:Record<string,unknown>;steps:Record<string,{status:string;output?:unknown}>;item?:{value:unknown;index:number}}): boolean {
  const value=evaluateExpression(condition,ctx);
  if(typeof value!=='boolean')throw new PlanError('non_boolean_condition');
  return value;
}
export const evaluateArguments=evaluateExpression;
/** Resolve exactly one reviewer-pinned Task child, never an arbitrary caller ID.
 * The compiler already reserves all possible identities and prevents collisions.
 * Session Action lifecycle is deliberately not supported here.
 */
export function publishedForeachTaskController(plan:Plan,stepId:string):Step|undefined{
  if(!Array.isArray(plan.steps))return undefined;
  for(const controller of plan.steps){
    if(controller.uses!=='flow.foreach')continue;
    const config=controller.with,child=config.template as {id?:unknown;uses?:unknown;with?:unknown}|undefined;
    if(child?.uses!=='github.run'||typeof child.id!=='string'||
       !Number.isSafeInteger(config.max_items)||Number(config.max_items)<1||
       Number(config.max_items)>PLAN_LIMITS.maxForeachItems)continue;
    for(let i=0;i<Number(config.max_items);i++)
      if(stepId===controller.id+'_'+i+'_'+child.id)return controller;
  }
  return undefined;
}
export function publishedGitHubActionStep(plan:Plan,stepId:string):Step|undefined{
  if(!Array.isArray(plan.steps))return undefined;
  const ordinary=plan.steps.find(s=>s.id===stepId);
  if(ordinary)return ordinary.uses==='github.run'?ordinary:undefined;
  for(const controller of plan.steps){
    if(controller.uses!=='flow.foreach')continue;
    const config=controller.with;
    const child=(Array.isArray(config.templates)?
      (config.templates as Array<{id?:unknown;uses?:unknown;with?:unknown}>)
        .find(c=>c.uses==='github.run'):config.template) as
      {id?:unknown;uses?:unknown;with?:unknown}|undefined;
    if(child?.uses!=='github.run'||typeof child.id!=='string'||
       !Number.isSafeInteger(config.max_items)||Number(config.max_items)<1||
       Number(config.max_items)>PLAN_LIMITS.maxForeachItems)continue;
    const withData=child.with as Record<string,unknown>|undefined;
    if(withData?.capability!=='github.action'||!withData.action||
       (withData.action as {type?:unknown}).type!=='task')continue;
    for(let i=0;i<Number(config.max_items);i++){
      if(stepId===controller.id+'_'+i+'_'+child.id)
        return {id:stepId,uses:'github.run',needs:controller.needs,with:withData};
    }
  }
  return undefined;
}

function checkGitHubActionWith(withData:Record<string,unknown>,path:string):void{
  keys(withData,['capability','action'],path);
  if(withData.capability!=='github.action')
    throw new PlanError('unsupported_github_capability',path+'/capability');
  const action=object(withData.action,'invalid_github_action');
  keys(action,['repository','repositoryId','workflowId','workflowPath','commitSha','type','contractDigest','ref','inputs'],path+'/action');
  if(typeof action.repository!=='string'||!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(action.repository)||
     !Number.isSafeInteger(action.repositoryId)||Number(action.repositoryId)<=0||
     !Number.isSafeInteger(action.workflowId)||Number(action.workflowId)<=0||
     typeof action.workflowPath!=='string'||!/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(action.workflowPath)||
     typeof action.commitSha!=='string'||!/^[a-f0-9]{40}$/i.test(action.commitSha)||
     typeof action.ref!=='string'||!/^refs\/tags\/[A-Za-z0-9][A-Za-z0-9._\/-]{0,190}$/.test(action.ref)||
     action.ref.includes('..')||action.ref.includes('//')||action.ref.endsWith('/')||
     !['task','session'].includes(String(action.type))||
     typeof action.contractDigest!=='string'||!/^[a-f0-9]{64}$/i.test(action.contractDigest))
    throw new PlanError('invalid_github_action',path+'/action');
  const inputs=object(action.inputs,'invalid_github_action_inputs');
  for(const [name,value] of Object.entries(inputs)){
    if(typeof value==='string'||typeof value==='boolean'||
       (typeof value==='number'&&Number.isFinite(value)))continue;
    if(action.type==='session'&&name==='duration_minutes'&&
       isSessionDurationInputRef(value))continue;
    // Foreach Task templates have their own exact item-ref validator,
    // preserving its detailed fail-closed rejection errors.
    if(action.type==='task')continue;
    throw new PlanError('invalid_github_action_inputs',path+'/action/inputs/'+name);
  }
}

// The first HTTP slice intentionally fixes POST bodies at Publish time.
// Runtime-evaluated body references would need a reviewed typed operation
// schema to prove parameters cannot widen the owner-approved effect scope.
function assertLiteralHttpBody(value:unknown,path:string,depth=0):void{
  if(depth>15)throw new PlanError('http_body_too_deep',path);
  if(Array.isArray(value)){for(const part of value)assertLiteralHttpBody(part,path,depth+1);return;}
  if(!value||typeof value!=='object')return;
  const entries=Object.entries(value as Record<string,unknown>);
  if(entries.length===1&&['ref','eq','ne','gt','lt','and','or','not'].includes(entries[0]![0]))
    throw new PlanError('http_dynamic_body_unsupported',path);
  for(const [,part] of entries)assertLiteralHttpBody(part,path,depth+1);
}

export async function compilePlan(source: string|unknown): Promise<{plan:Plan; digest:string}>{
  let raw:unknown=source;
  if(typeof source==='string'){
    if(new TextEncoder().encode(source).byteLength>PLAN_LIMITS.definitionBytes)throw new PlanError('definition_too_large');
    try{ const doc=YAML.parseDocument(source,{uniqueKeys:true,strict:true});if(doc.errors.length)throw Error('invalid_yaml');raw=doc.toJS({maxAliasCount:16}); }
    catch{throw new PlanError('invalid_yaml_or_json');}
  }
  validateFiniteNumbers(raw);
  const o=object(raw,'invalid_definition');keys(o,['version','name','inputs','triggers','steps','saga']);
  let saga:{on:('failure'|'cancel')[]}|undefined;
  if(o.saga!==undefined){
    const spec=object(o.saga,'invalid_saga');
    keys(spec,['on'],'/saga');
    if(!Array.isArray(spec.on)||spec.on.length<1||spec.on.length>2||
       new Set(spec.on).size!==spec.on.length||
       spec.on.some(x=>x!=='failure'&&x!=='cancel'))
      throw new PlanError('invalid_saga','/saga/on');
    saga={on:spec.on as ('failure'|'cancel')[]};
  }
  if(o.version!==1)throw new PlanError('invalid_version');
  if(typeof o.name!=='string'||!o.name.trim()||o.name.length>120)throw new PlanError('invalid_name');
  if(!Array.isArray(o.steps)||o.steps.length<1||o.steps.length>PLAN_LIMITS.maxSteps)throw new PlanError('invalid_step_count');
  if(o.inputs!==undefined) {const inp=object(o.inputs,'invalid_inputs');if(Object.keys(inp).length>PLAN_LIMITS.maxInputs)throw new PlanError('too_many_inputs');}
  let triggers:WorkflowTrigger[]|undefined;
  if(o.triggers!==undefined){
    if(!Array.isArray(o.triggers)||o.triggers.length!==1)
      throw new PlanError('invalid_triggers','/triggers');
    const item=object(o.triggers[0],'invalid_trigger');
    if(item.type==='cron'){
      keys(item,['type','schedule'],'/triggers/0');
      try{parseUtcCron(item.schedule);}
      catch{throw new PlanError('invalid_cron_schedule','/triggers/0/schedule');}
      triggers=[{type:'cron',schedule:item.schedule as string}];
    }else if(item.type==='webhook'){
      keys(item,['type','token_sha256'],'/triggers/0');
      if(typeof item.token_sha256!=='string'||!/^[a-f0-9]{64}$/.test(item.token_sha256))
        throw new PlanError('invalid_webhook_token_hash','/triggers/0/token_sha256');
      triggers=[{type:'webhook',token_sha256:item.token_sha256}];
    }else if(item.type==='github_event'){
      keys(item,['type','repository','repository_id','event','ref','workflow_path'],'/triggers/0');
      const repo=typeof item.repository==='string'&&GITHUB_EVENT_PATTERNS.repository.test(item.repository);
      if(!repo)throw new PlanError('invalid_github_event_repository','/triggers/0/repository');
      if(!Number.isSafeInteger(item.repository_id)||Number(item.repository_id)<=0)
        throw new PlanError('invalid_github_event_repository_id','/triggers/0/repository_id');
      if(item.event!=='push')throw new PlanError('unsupported_github_event','/triggers/0/event');
      const ref=typeof item.ref==='string'&&GITHUB_EVENT_PATTERNS.ref.test(item.ref);
      if(!ref)throw new PlanError('invalid_github_event_ref','/triggers/0/ref');
      const workflow=typeof item.workflow_path==='string'&&
        GITHUB_EVENT_PATTERNS.workflow_path.test(item.workflow_path);
      if(!workflow)throw new PlanError('invalid_github_event_workflow','/triggers/0/workflow_path');
      if(!o.inputs||typeof o.inputs!=='object'||Array.isArray(o.inputs)||
         !Object.hasOwn(o.inputs,'github'))
        throw new PlanError('invalid_github_event_inputs','/inputs/github');
      triggers=[{type:'github_event',repository:item.repository as string,
        repository_id:item.repository_id as number,event:'push',
        ref:item.ref as string,workflow_path:item.workflow_path as string}];
    }else throw new PlanError('unsupported_trigger','/triggers/0/type');
  }
  // Literal repeat compiles to ordinary DAG Steps. Dynamic foreach/loop
  // reserve the full possible expansion budget before any execution.
  const expanded:unknown[]=[];
  let dynamicReserved=0;
  const foreachChildren=new Set<string>();
  for(let i=0;i<o.steps.length;i++){
    const candidate=object(o.steps[i],'invalid_step');
    if(!Object.hasOwn(candidate,'flow')){
      // Source callers cannot masquerade as an internal compiled Flow Step.
      // Only validated source Flow branches may produce these internal opcodes.
      if(candidate.uses==='flow.foreach'||candidate.uses==='flow.child'||candidate.uses==='flow.wait'||candidate.uses==='flow.wait_event'||candidate.uses==='flow.loop')
        throw new PlanError('unsupported_capability','/steps/'+i+'/uses');
      expanded.push(candidate);
      if(expanded.length+dynamicReserved>PLAN_LIMITS.maxSteps)
        throw new PlanError('invalid_step_count','/steps');
      continue;
    }
    const path='/steps/'+i;
    if(candidate.flow==='wait'){
      // A source-level relative wait uses only literal integer seconds.
      // Bound total delay across the whole Plan to protect the 8 Run slots.
      keys(candidate,['id','flow','duration_seconds','needs'],path);
      if(typeof candidate.id!=='string'||!SAFE_ID.test(candidate.id)||
         OBJECT_PROTOTYPE_KEYS.has(candidate.id))
        throw new PlanError('invalid_step_id',path+'/id');
      if(!Number.isSafeInteger(candidate.duration_seconds)||
         Number(candidate.duration_seconds)<1||
         Number(candidate.duration_seconds)>PLAN_LIMITS.maxWaitSeconds)
        throw new PlanError('invalid_wait_duration',path+'/duration_seconds');
      const deps=candidate.needs??[];
      if(!Array.isArray(deps)||deps.some(d=>typeof d!=='string'||!SAFE_ID.test(d))||
         new Set(deps).size!==deps.length)
        throw new PlanError('invalid_dependencies',path+'/needs');
      expanded.push({id:candidate.id,uses:'flow.wait',needs:deps,
        with:{duration_seconds:candidate.duration_seconds}});
      if(expanded.length+dynamicReserved>PLAN_LIMITS.maxSteps)
        throw new PlanError('invalid_step_count','/steps');
      continue;
    }
    if(candidate.flow==='wait_event'){
      keys(candidate,['id','flow','token_sha256','timeout_seconds','needs'],path);
      if(typeof candidate.id!=='string'||!SAFE_ID.test(candidate.id)||
         OBJECT_PROTOTYPE_KEYS.has(candidate.id))
        throw new PlanError('invalid_step_id',path+'/id');
      if(typeof candidate.token_sha256!=='string'||!/^[a-f0-9]{64}$/.test(candidate.token_sha256))
        throw new PlanError('invalid_event_token_hash',path+'/token_sha256');
      if(!Number.isSafeInteger(candidate.timeout_seconds)||
         Number(candidate.timeout_seconds)<1||
         Number(candidate.timeout_seconds)>PLAN_LIMITS.maxEventWaitSeconds)
        throw new PlanError('invalid_event_wait_timeout',path+'/timeout_seconds');
      const deps=candidate.needs??[];
      if(!Array.isArray(deps)||deps.some(d=>typeof d!=='string'||!SAFE_ID.test(d))||
         new Set(deps).size!==deps.length)
        throw new PlanError('invalid_dependencies',path+'/needs');
      expanded.push({id:candidate.id,uses:'flow.wait_event',needs:deps,
        with:{token_sha256:candidate.token_sha256,timeout_seconds:candidate.timeout_seconds}});
      if(expanded.length+dynamicReserved>PLAN_LIMITS.maxSteps)
        throw new PlanError('invalid_step_count','/steps');
      continue;
    }
    if(candidate.flow==='child'){
      keys(candidate,['id','flow','workflow_id','version_id','inputs','needs','mode'],path);
      if(candidate.mode!==undefined&&candidate.mode!=='detached')
        throw new PlanError('invalid_child_mode',path+'/mode');
      if(typeof candidate.id!=='string'||!SAFE_ID.test(candidate.id)||OBJECT_PROTOTYPE_KEYS.has(candidate.id))
        throw new PlanError('invalid_step_id',path+'/id');
      if(typeof candidate.workflow_id!=='string'||!UUID_RE.test(candidate.workflow_id)||
         typeof candidate.version_id!=='string'||!UUID_RE.test(candidate.version_id))
        throw new PlanError('invalid_child_identity',path+'/workflow_id');
      const inputs=object(candidate.inputs,'invalid_child_inputs');
      if(Object.keys(inputs).length>PLAN_LIMITS.maxInputs)
        throw new PlanError('invalid_child_inputs',path+'/inputs');
      const deps=candidate.needs??[];
      if(!Array.isArray(deps)||deps.some(d=>typeof d!=='string'||!SAFE_ID.test(d))||new Set(deps).size!==deps.length)
        throw new PlanError('invalid_dependencies',path+'/needs');
      expanded.push({id:candidate.id,uses:'flow.child',needs:deps,
        with:{workflow_id:candidate.workflow_id,version_id:candidate.version_id,inputs,
          ...(candidate.mode==='detached'?{mode:'detached'}:{})}});
      if(expanded.length+dynamicReserved>PLAN_LIMITS.maxSteps)
        throw new PlanError('invalid_step_count','/steps');
      continue;
    }
    if(candidate.flow==='while'||candidate.flow==='until'){
      // Each bounded iteration reserves an existing Plan budget unit.
      // Only pure emit or one specifically reviewed read-only MCP Action may
      // run per iteration; nested/other effects remain unsupported.
      keys(candidate,['id','flow','needs','condition','max_iterations','template'],path);
      if(typeof candidate.id!=='string'||!SAFE_ID.test(candidate.id)||
         OBJECT_PROTOTYPE_KEYS.has(candidate.id))
        throw new PlanError('invalid_step_id',path+'/id');
      const deps=candidate.needs??[];
      if(!Array.isArray(deps)||deps.some(d=>typeof d!=='string'||!SAFE_ID.test(d))||
         new Set(deps).size!==deps.length)
        throw new PlanError('invalid_dependencies',path+'/needs');
      if(!Number.isSafeInteger(candidate.max_iterations)||
         Number(candidate.max_iterations)<1||
         Number(candidate.max_iterations)>PLAN_LIMITS.maxRepeat)
        throw new PlanError('invalid_loop_limit',path+'/max_iterations');
      const template=object(candidate.template,'invalid_loop_template');
      keys(template,['uses','with'],path+'/template');
      if(template.uses!=='result.emit'&&template.uses!=='mcp.call')
        throw new PlanError('unsupported_loop_action',path+'/template/uses');
      const withData=object(template.with,'invalid_loop_template');
      let compiledTemplate:{uses:'result.emit'|'mcp.call';with:Record<string,unknown>};
      if(template.uses==='result.emit'){
        keys(withData,['data'],path+'/template/with');
        if(!Object.hasOwn(withData,'data'))
          throw new PlanError('invalid_loop_template',path+'/template/with/data');
        compiledTemplate={uses:'result.emit',with:{data:withData.data}};
      }else{
        const target=path+'/template/with';
        keys(withData,['endpoint','tool','scope','arguments','input_schema','output_schema'],target);
        if(typeof withData.endpoint!=='string')throw new PlanError('invalid_endpoint',target+'/endpoint');
        try{if(publicMcpEndpoint(withData.endpoint).href!==withData.endpoint)throw Error('noncanonical');}
        catch{throw new PlanError('invalid_endpoint',target+'/endpoint');}
        if(typeof withData.tool!=='string'||!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,127}$/.test(withData.tool))
          throw new PlanError('invalid_tool',target+'/tool');
        if(withData.scope!=='read')throw new PlanError('unsupported_operation_scope',target+'/scope');
        object(withData.arguments,'invalid_step_arguments');
        compiledTemplate={uses:'mcp.call',with:{...withData,
          schema_digest:await toolSchemaDigest(withData.input_schema,withData.output_schema)}};
      }
      const ctx={id:candidate.id,needs:deps};
      const check=(value:unknown,field:string)=>
        expression(value,ctx,0,false,true,path+field);
      check(candidate.condition,'/condition');
      const op=candidate.condition&&typeof candidate.condition==='object'&&
        !Array.isArray(candidate.condition)?Object.keys(candidate.condition):[];
      if(typeof candidate.condition!=='boolean'&&
         !(op.length===1&&['ref','eq','ne','gt','lt','and','or','not'].includes(op[0])))
        throw new PlanError('invalid_loop_condition',path+'/condition');
      if(template.uses==='mcp.call')
        expression(withData.arguments,ctx,0,true,true,path+'/template/with/arguments');
      else check(withData.data,'/template/with/data');
      dynamicReserved+=Number(candidate.max_iterations);
      expanded.push({id:candidate.id,uses:'flow.loop',needs:deps,with:{
        mode:candidate.flow,max_iterations:candidate.max_iterations,
        condition:candidate.condition,template:compiledTemplate,
      }});
      if(expanded.length+dynamicReserved>PLAN_LIMITS.maxSteps)
        throw new PlanError('invalid_step_count','/steps');
      continue;
    }
    if(candidate.flow==='foreach'){
      keys(candidate,['id','flow','needs','items','max_items','template'],path);
      if(typeof candidate.id!=='string'||!SAFE_ID.test(candidate.id)||
         OBJECT_PROTOTYPE_KEYS.has(candidate.id))throw new PlanError('invalid_step_id',path+'/id');
      if(!Number.isSafeInteger(candidate.max_items)||Number(candidate.max_items)<1||
         Number(candidate.max_items)>PLAN_LIMITS.maxForeachItems)
        throw new PlanError('invalid_foreach_limit',path+'/max_items');
      const source=object(candidate.items,'invalid_foreach_items');
      if(Object.keys(source).length!==1||typeof source.ref!=='string')
        throw new PlanError('invalid_foreach_items',path+'/items');
      const templ={...object(candidate.template,'invalid_foreach_template')};
      keys(templ,['steps'],path+'/template');
      // Preserve existing foreach Task identity, grants and Run behavior.
      // Cloudflare actions remain rejected in every template shape.
      if(Array.isArray(templ.steps))templ.steps=templ.steps.map((entry,index)=>{
        const child=object(entry,'invalid_foreach_template');
        if(child.uses!=='action.run')return child;
        const input=object(child.with,'invalid_step_arguments');
        const target=path+'/template/steps/'+index+'/with';
        keys(input,['executor','capability','action'],target);
        if(input.executor!=='github')throw new PlanError('unsupported_foreach_executor',target+'/executor');
        return {...child,uses:'github.run',with:{capability:input.capability,action:input.action}};
      });
      if(!Array.isArray(templ.steps)||templ.steps.length<1||
         templ.steps.length>PLAN_LIMITS.maxForeachTemplateSteps)
        throw new PlanError('unsupported_foreach_template',path+'/template/steps');
      // Only one reviewed, literal-input Task among up to four ordered
      // emit/read-only MCP stages. More than one GitHub effect per item
      // remains unsupported, even if the Actions have different IDs.
      if(templ.steps.length>1){
        const taskCount=templ.steps.filter(item=>
          item&&typeof item==='object'&&!Array.isArray(item)&&
          (item as {uses?:unknown}).uses==='github.run').length;
        if(taskCount>1)
          throw new PlanError('unsupported_foreach_action',path+'/template/steps');
        const originalNeeds=candidate.needs===undefined?[]:candidate.needs;
        if(!Array.isArray(originalNeeds)||originalNeeds.some(x=>typeof x!=='string'||!SAFE_ID.test(x))||
           new Set(originalNeeds).size!==originalNeeds.length)
          throw new PlanError('invalid_dependencies',path+'/needs');
        const children=await Promise.all(templ.steps.map(async(sourceStep,index)=>{
          const childPath=path+'/template/steps/'+index;
          const child=object(sourceStep,'invalid_foreach_template');
          keys(child,['id','uses','with','if'],childPath);
          if(typeof child.id!=='string'||!SAFE_ID.test(child.id)||
             OBJECT_PROTOTYPE_KEYS.has(child.id)||child.id==='prototype'||
             originalNeeds.includes(child.id))
            throw new PlanError('invalid_step_id',childPath+'/id');
          const args=object(child.with,'invalid_step_arguments');
          if(child.uses==='result.emit'){
            keys(args,['data'],childPath+'/with');
            return child as {id:string;uses:'result.emit'|'mcp.call';with:Record<string,unknown>;if?:unknown};
          }
          if(child.uses==='github.run'){
            const target=childPath+'/with';
            checkGitHubActionWith(args,target);
            const action=args.action as Record<string,unknown>;
            if(action.type!=='task')
              throw new PlanError('unsupported_foreach_action',target+'/action/type');
            const inputs=action.inputs as Record<string,unknown>;
            if(Object.values(inputs).some(v=>
              typeof v!=='string'&&typeof v!=='boolean'&&
              (typeof v!=='number'||!Number.isFinite(v))))
              throw new PlanError('unsupported_foreach_inputs',target+'/action/inputs');
            return child as {id:string;uses:'result.emit'|'mcp.call'|'github.run';with:Record<string,unknown>;if?:unknown};
          }
          if(child.uses!=='mcp.call')
            throw new PlanError('unsupported_foreach_action',childPath+'/uses');
          const target=childPath+'/with';
          keys(args,['endpoint','tool','scope','arguments','input_schema','output_schema'],target);
          if(typeof args.endpoint!=='string')throw new PlanError('invalid_endpoint',target+'/endpoint');
          try{if(publicMcpEndpoint(args.endpoint).href!==args.endpoint)throw Error('noncanonical');}
          catch{throw new PlanError('invalid_endpoint',target+'/endpoint');}
          if(typeof args.tool!=='string'||!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,127}$/.test(args.tool))
            throw new PlanError('invalid_tool',target+'/tool');
          if(args.scope!=='read')throw new PlanError('unsupported_operation_scope',target+'/scope');
          object(args.arguments,'invalid_step_arguments');
          const schema_digest=await toolSchemaDigest(args.input_schema,args.output_schema);
          return {...child,with:{...args,schema_digest}} as unknown as
            {id:string;uses:'result.emit'|'mcp.call';with:Record<string,unknown>;if?:unknown};
        }));
        if(new Set(children.map(child=>child.id)).size!==children.length)
          throw new PlanError('invalid_step_id',path+'/template/steps');
        for(let n=0;n<Number(candidate.max_items);n++)for(const child of children){
          const generatedId=candidate.id+'_'+n+'_'+child.id;
          if(!SAFE_ID.test(generatedId)||foreachChildren.has(generatedId))
            throw new PlanError('invalid_step_id',path+'/id');
          foreachChildren.add(generatedId);
        }
        dynamicReserved+=Number(candidate.max_items)*children.length;
        expanded.push({id:candidate.id,uses:'flow.foreach',needs:originalNeeds,
          with:{items:source,max_items:candidate.max_items,templates:children}});
        if(expanded.length+dynamicReserved>PLAN_LIMITS.maxSteps)
          throw new PlanError('invalid_step_count','/steps');
        continue;
      }
      const child=object(templ.steps[0],'invalid_foreach_template');
      keys(child,['id','uses','with','if'],path+'/template/steps/0');
      if(typeof child.id!=='string'||!SAFE_ID.test(child.id)||
         OBJECT_PROTOTYPE_KEYS.has(child.id))throw new PlanError('invalid_step_id',path+'/template/steps/0/id');
      // A single reviewed GitHub Task may run per item, but its dispatch
      // identity and input values must remain literals pinned at Publish.
      if(child.uses!=='result.emit'&&child.uses!=='mcp.call'&&child.uses!=='github.run')
        throw new PlanError('unsupported_foreach_action',path+'/template/steps/0/uses');
      const args=object(child.with,'invalid_step_arguments');
      let compiledChild=child;
      if(child.uses==='mcp.call'){
        const target=path+'/template/steps/0/with';
        keys(args,['endpoint','tool','scope','arguments','input_schema','output_schema'],target);
        if(typeof args.endpoint!=='string')throw new PlanError('invalid_endpoint',target+'/endpoint');
        try{if(publicMcpEndpoint(args.endpoint).href!==args.endpoint)throw Error('noncanonical');}
        catch{throw new PlanError('invalid_endpoint',target+'/endpoint');}
        if(typeof args.tool!=='string'||!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,127}$/.test(args.tool))
          throw new PlanError('invalid_tool',target+'/tool');
        if(args.scope!=='read')throw new PlanError('unsupported_operation_scope',target+'/scope');
        object(args.arguments,'invalid_step_arguments');
        const schema_digest=await toolSchemaDigest(args.input_schema,args.output_schema);
        compiledChild={...child,with:{...args,schema_digest}};
      }else if(child.uses==='github.run'){
        const target=path+'/template/steps/0/with';
        checkGitHubActionWith(args,target);
        const action=args.action as Record<string,unknown>;
        if(action.type!=='task')
          throw new PlanError('unsupported_foreach_action',target+'/action/type');
        const inputs=action.inputs as Record<string,unknown>;
        // Only current-item ref objects or strict JSON primitives are
        // permitted. Publish checks provider types; Run checks all frozen
        // resolved values and pins the digest before any GitHub POST.
        for(const value of Object.values(inputs))
          if(typeof value!=='string'&&typeof value!=='boolean'&&
             (typeof value!=='number'||!Number.isFinite(value))&&
             !isForeachTaskInputRef(value))
            throw new PlanError('unsupported_foreach_inputs',target+'/action/inputs');
      }else keys(args,['data'],path+'/template/steps/0/with');
      const originalNeeds=candidate.needs===undefined?[]:candidate.needs;
      if(!Array.isArray(originalNeeds)||originalNeeds.some(x=>typeof x!=='string'||!SAFE_ID.test(x))||
         new Set(originalNeeds).size!==originalNeeds.length)
        throw new PlanError('invalid_dependencies',path+'/needs');
      for(let n=0;n<Number(candidate.max_items);n++){
        const generatedId=candidate.id+'_'+n+'_'+child.id;
        if(!SAFE_ID.test(generatedId)||foreachChildren.has(generatedId))
          throw new PlanError('invalid_step_id',path+'/id');
        foreachChildren.add(generatedId);
      }
      dynamicReserved+=Number(candidate.max_items);
      expanded.push({id:candidate.id,uses:'flow.foreach',needs:originalNeeds,
        with:{items:source,max_items:candidate.max_items,template:compiledChild}});
      if(expanded.length+dynamicReserved>PLAN_LIMITS.maxSteps)
        throw new PlanError('invalid_step_count','/steps');
      continue;
    }
    keys(candidate,['id','flow','times','needs','template'],path);
    if(candidate.flow!=='repeat')throw new PlanError('unsupported_flow',path+'/flow');
    if(typeof candidate.id!=='string'||!SAFE_ID.test(candidate.id)||
       OBJECT_PROTOTYPE_KEYS.has(candidate.id))
      throw new PlanError('invalid_step_id',path+'/id');
    if(!Number.isSafeInteger(candidate.times)||Number(candidate.times)<1||
       Number(candidate.times)>PLAN_LIMITS.maxRepeat)
      throw new PlanError('invalid_repeat_count',path+'/times');
    const template=object(candidate.template,'invalid_repeat_template');
    keys(template,['uses','with','if'],path+'/template');
    if(!isSupportedStepUse(template.uses)||template.uses==='http.request')
      throw new PlanError('unsupported_capability',path+'/template/uses');
    if(template.uses==='action.run' &&
       (template.with as {executor?:unknown}|undefined)?.executor==='cloudflare')
      throw new PlanError('unsupported_cloudflare_composition',path+'/template/uses');
    const originalNeeds=candidate.needs===undefined?[]:candidate.needs;
    if(!Array.isArray(originalNeeds)||originalNeeds.some(x=>typeof x!=='string'||!SAFE_ID.test(x))||
       new Set(originalNeeds).size!==originalNeeds.length)
      throw new PlanError('invalid_dependencies',path+'/needs');
    for(let n=0;n<(candidate.times as number);n++){
      const generatedId=candidate.id+'_'+n;
      if(!SAFE_ID.test(generatedId)||OBJECT_PROTOTYPE_KEYS.has(generatedId))
        throw new PlanError('invalid_step_id',path+'/id');
      expanded.push({id:generatedId,uses:template.uses,with:template.with,
        ...(template.if===undefined?{}:{if:template.if}),
        needs:[...originalNeeds,...(n? [candidate.id+'_'+(n-1)]:[])]});
      if(expanded.length+dynamicReserved>PLAN_LIMITS.maxSteps)
        throw new PlanError('invalid_step_count','/steps');
    }
  }
  // Ensure no generated dynamic ID can shadow a published Step ID.
  for(const candidate of expanded){
    const id=(candidate as {id?:unknown}).id;
    if(typeof id==='string'&&foreachChildren.has(id))
      throw new PlanError('invalid_step_id','/steps');
  }
  if(expanded.filter(x=>(x as {approval?:unknown}).approval!==undefined).length>1)
    throw new PlanError('multiple_approval_gates_unsupported','/steps');
  if(expanded.filter(x=>(x as {uses?:unknown}).uses==='flow.wait_event').length>1)
    throw new PlanError('multiple_event_wait_steps_unsupported','/steps');
  if(expanded.filter(x=>(x as {uses?:unknown}).uses==='flow.child').length>1)
    throw new PlanError('multiple_child_steps_unsupported','/steps');
  const totalWaitSeconds=expanded.reduce<number>((sum,x)=>{
    const step=x as {uses?:unknown;with?:{duration_seconds?:number}};
    return sum+(step.uses==='flow.wait'?Number(step.with?.duration_seconds):0);
  },0);
  if(totalWaitSeconds>PLAN_LIMITS.maxWaitSeconds)
    throw new PlanError('wait_budget_exceeded','/steps');
  // Current reviewed Provider is one notification from one physical OpenList Session.
  if(expanded.filter(x=>(x as {uses?:unknown;with?:{executor?:unknown}}).uses==='action.run'&&
      (x as {with?:{executor?:unknown}}).with?.executor==='cloudflare').length>1)
    throw new PlanError('multiple_cloudflare_actions_unsupported','/steps');
  const steps:Step[]=[];
  const ids=new Set<string>();
  for(const s0 of expanded){
    const sourceStep=object(s0,'invalid_step');
    const stepPath='/steps/'+steps.length;
    // The source-level unified GitHub spelling reuses the mature dispatch,
    // OIDC, terminal-state and grant machinery. Do not touch old Plan JSON.
    // Cloudflare actions remain distinct and require audited grants and receipts;
    // never reinterpret their source as GitHub dispatch.
    const s:Record<string,unknown>=sourceStep.uses==='action.run'?(()=>{
      const withData=object(sourceStep.with,'invalid_step_arguments');
      keys(withData,withData.executor==='cloudflare'?['executor','provider','action','contract_digest','input']:['executor','capability','action'],stepPath+'/with');
      if(withData.executor==='cloudflare'){
        return sourceStep; // Never reinterpret Cloudflare as a GitHub dispatch.
      }
      if(withData.executor!=='github')
        throw new PlanError('unsupported_executor',stepPath+'/with/executor');
      return {...sourceStep,uses:'github.run',
        with:{capability:withData.capability,action:withData.action}};
    })():sourceStep;
    keys(s,['id','uses','needs','needs_policy','if','with','approval','compensate'],stepPath);
    if(s.approval!==undefined){
      const a=object(s.approval,'invalid_runtime_approval');
      keys(a,['required'],stepPath+'/approval');
      if(a.required!==true||s.uses!=='github.run')
        throw new PlanError('approval_not_applicable',stepPath+'/approval');
    }
    if(typeof s.id!=='string'||!SAFE_ID.test(s.id)||ids.has(s.id)||OBJECT_PROTOTYPE_KEYS.has(s.id))throw new PlanError('invalid_step_id');
    ids.add(s.id);
    if(!['flow.foreach','flow.child','flow.wait','flow.wait_event','flow.loop'].includes(String(s.uses))&&!isSupportedStepUse(s.uses))throw new PlanError('unsupported_capability',stepPath+'/uses');
    const needs=s.needs===undefined?[]:s.needs;
    if(!Array.isArray(needs)||needs.some(n=>typeof n!=='string'||!SAFE_ID.test(n))||new Set(needs).size!==needs.length)throw new PlanError('invalid_dependencies');
    // Opt-in branch fan-in: completed/skipped dependencies may join, but a
    // failed/indeterminate dependency never authorizes downstream effects.
    if(s.needs_policy!==undefined&&s.needs_policy!=='all_succeeded'&&s.needs_policy!=='allow_skipped')
      throw new PlanError('invalid_needs_policy',stepPath+'/needs_policy');
    if(s.needs_policy==='allow_skipped'&&!needs.length)
      throw new PlanError('invalid_needs_policy',stepPath+'/needs_policy');
    const withData=object(s.with,'invalid_step_arguments');
    if(s.uses==='flow.loop'){
      keys(withData,['mode','condition','max_iterations','template'],stepPath+'/with');
    }else if(s.uses==='flow.foreach'){
      keys(withData,['items','max_items','template','templates'],stepPath+'/with');
    }else if(s.uses==='flow.child'){
      keys(withData,['workflow_id','version_id','inputs','mode'],stepPath+'/with');
      if(withData.mode!==undefined&&withData.mode!=='detached')
        throw new PlanError('invalid_child_mode',stepPath+'/with/mode');
    }else if(s.uses==='flow.wait'){
      keys(withData,['duration_seconds'],stepPath+'/with');
    }else if(s.uses==='flow.wait_event'){
      keys(withData,['token_sha256','timeout_seconds'],stepPath+'/with');
    }else if(s.uses==='action.run'){
      keys(withData,['executor','provider','action','contract_digest','input'],stepPath+'/with');
      const manifest=await cloudflareActionManifest(withData.action==='weixin.notify_download'?'download':withData.provider==='bark'?'bark':'unified-generic');
      if(withData.executor!==manifest.executor||withData.provider!==manifest.provider||
         withData.action!==manifest.action||withData.contract_digest!==manifest.contract_digest)
        throw new PlanError('cloudflare_action_not_reviewed',stepPath+'/with');
      const input=object(withData.input,'invalid_cloudflare_input');
      if(manifest.provider==='bark'){
        keys(input,['notification'],stepPath+'/with/input');
        const notification=object(input.notification,'invalid_bark_notification');
        const allowed=Object.keys(manifest.input_schema.properties);
        keys(notification,allowed,stepPath+'/with/input/notification');
        if(!Object.hasOwn(notification,'body'))throw new PlanError('missing_bark_body',stepPath+'/with/input/notification');
        if(typeof notification.body==='string'&&notification.body.length>2400)
          throw new PlanError('bark_body_too_large',stepPath+'/with/input/notification');
      }else if(manifest.action==='weixin.notify_download'){
        keys(input,['download_step_id'],stepPath+'/with/input');
        if(typeof input.download_step_id!=='string'||!SAFE_ID.test(input.download_step_id))
          throw new PlanError('invalid_trusted_download_reference',stepPath+'/with/input/download_step_id');
      }else{
        keys(input,['text','session_step_id'],stepPath+'/with/input');
        if(typeof input.text!=='string'||!input.text.trim()||input.text.length>2048||
           new TextEncoder().encode(input.text).byteLength>4096)
          throw new PlanError('invalid_weixin_text',stepPath+'/with/input/text');
        if(input.session_step_id!==undefined&&
          (typeof input.session_step_id!=='string'||!SAFE_ID.test(input.session_step_id)))
          throw new PlanError('invalid_trusted_session_reference',stepPath+'/with/input/session_step_id');
      }
    }else if(s.uses==='github.run'){
      checkGitHubActionWith(withData,stepPath+'/with');
      const action=withData.action as Record<string,unknown>;
      const actionInputs=action.inputs as Record<string,unknown>;
      if(action.type==='session'&&isSessionDurationInputRef(actionInputs.duration_minutes)){
        // Runtime variation is limited to this one reviewed numeric field.
        // Every such Plan has the same default and an explicit expiry mode.
        if((o.inputs as Record<string,unknown>|undefined)?.duration_minutes!==300||
           actionInputs.duration_mode!=='explicit')
          throw new PlanError('invalid_session_duration_binding',
            stepPath+'/with/action/inputs/duration_minutes');
      }
    }else if(s.uses==='http.request'){
      keys(withData,['url','method','body'],stepPath+'/with');
      try{httpOperation(withData);}catch{throw new PlanError('invalid_http_operation',stepPath+'/with');}
      if(withData.method!=='POST'&&Object.hasOwn(withData,'body'))
        throw new PlanError('invalid_http_body',stepPath+'/with/body');
    }else if(s.uses==='mcp.call'){
      keys(withData,['endpoint','tool','scope','arguments','input_schema','output_schema'],stepPath+'/with');
      if(typeof withData.endpoint!=='string')throw new PlanError('invalid_endpoint',stepPath+'/with/endpoint');
      try { if(publicMcpEndpoint(withData.endpoint).href!==withData.endpoint)throw Error('noncanonical'); }
      catch { throw new PlanError('invalid_endpoint',stepPath+'/with/endpoint'); }
      if(typeof withData.tool!=='string'||!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,127}$/.test(withData.tool))throw new PlanError('invalid_tool',stepPath+'/with/tool');
      if(withData.scope!=='read'&&withData.scope!=='write')throw new PlanError('unsupported_operation_scope',stepPath+'/with/scope');
      object(withData.arguments,'invalid_step_arguments');
      if(withData.scope==='write' && !reviewedWriteArguments(withData.arguments,withData.tool as string))
        throw new PlanError('unreviewed_write_operation',stepPath+'/with');
      // Only explicit, bounded expected schema objects may be pinned; never a
      // dynamic expression or network-fetched schema silently approved later.
      await toolSchemaDigest(withData.input_schema,withData.output_schema);
    }else keys(withData,['data'],stepPath+'/with');
    let compensate:Step['compensate'];
    if(s.compensate!==undefined){
      const policy=object(s.compensate,'invalid_compensation');
      keys(policy,['kind'],stepPath+'/compensate');
      const action=s.uses==='github.run'?(withData.action as Record<string,unknown>):null;
      const inputs=action?.inputs as Record<string,unknown>|undefined;
      if(!saga||policy.kind!=='github.session.cancel'||
         action?.type!=='session'||inputs?.session_mode!=='temporary'||
         action?.repository!=='lirtual/session-actions'||
         action?.workflowPath!=='.github/workflows/ubuntu.yml')
        throw new PlanError('compensation_not_supported',stepPath+'/compensate');
      compensate={kind:'github.session.cancel'};
    }
    if(saga && ((s.uses==='github.run'&&!compensate)||
       ['mcp.call','http.request','action.run','flow.foreach','flow.child','flow.loop'].includes(String(s.uses))))
      throw new PlanError('saga_uncompensated_effect',stepPath);
    const compiledWith=s.uses==='mcp.call'?
      {...withData,schema_digest:await toolSchemaDigest(withData.input_schema,withData.output_schema)}:withData;
    steps.push({id:s.id,uses:s.uses as Step['uses'],needs:needs as string[],
      ...(s.needs_policy==='allow_skipped'?{needs_policy:'allow_skipped' as const}:{}),
      with:compiledWith,...(s.if===undefined?{}:{if:s.if}),
      ...(s.approval===undefined?{}:{approval:{required:true}}),
      ...(compensate?{compensate}:{})});
  }
  for(const s of steps){
    if(s.uses==='action.run'&&s.with.action==='weixin.notify_download'){
      const source=(s.with.input as {download_step_id:string}).download_step_id;
      const upstream=steps.find(x=>x.id===source);
      const template=upstream?.with.template as {uses?:unknown;action?:unknown;with?:{action?:unknown}}|undefined;
      const action=(template?.with?.action??template?.action) as {repository?:unknown;workflowPath?:unknown;type?:unknown}|undefined;
      if(!s.needs.includes(source)||upstream?.uses!=='flow.foreach'||
         upstream.with.max_items!==1||template?.uses!=='github.run'||
         action?.repository!=='lirtual/session-actions'||
         action?.workflowPath!=='.github/workflows/download.yml'||action?.type!=='task')
        throw new PlanError('untrusted_download_reference','/steps/'+steps.indexOf(s)+'/with/input/download_step_id');
    }
    if(s.uses==='action.run'&&s.with.action==='weixin.send_text'){
      // Provider URL and recipient never come from a Draft or ordinary Step output.
      const source=(s.with.input as {session_step_id?:string}).session_step_id;
      if(source!==undefined){
        const upstream=steps.find(x=>x.id===source);
        const action=upstream?.with.action as {repository?:unknown;workflowPath?:unknown;type?:unknown}|undefined;
        if(!s.needs.includes(source)||upstream?.uses!=='github.run'||
           action?.repository!=='lirtual/session-actions'||
           action?.workflowPath!=='.github/workflows/openlist.yml'||
           action?.type!=='session')
          throw new PlanError('untrusted_session_reference','/steps/'+steps.indexOf(s)+'/with/input/session_step_id');
      }
    }
    for(const dep of s.needs)if(!ids.has(dep)||dep===s.id)throw new PlanError('invalid_dependencies');
    if(s.uses==='flow.wait'){
      if(!Number.isSafeInteger(s.with.duration_seconds)||Number(s.with.duration_seconds)<1||
         Number(s.with.duration_seconds)>PLAN_LIMITS.maxWaitSeconds)
        throw new PlanError('invalid_wait_duration','/steps/'+steps.indexOf(s)+'/duration_seconds');
    }else if(s.uses==='flow.wait_event'){
      if(typeof s.with.token_sha256!=='string'||!/^[a-f0-9]{64}$/.test(s.with.token_sha256))
        throw new PlanError('invalid_event_token_hash','/steps/'+steps.indexOf(s)+'/token_sha256');
      if(!Number.isSafeInteger(s.with.timeout_seconds)||Number(s.with.timeout_seconds)<1||
         Number(s.with.timeout_seconds)>PLAN_LIMITS.maxEventWaitSeconds)
        throw new PlanError('invalid_event_wait_timeout','/steps/'+steps.indexOf(s)+'/timeout_seconds');
    }else if(s.uses==='flow.loop'){
      // Source validation above owns item-context expressions and mode limits.
    }else if(s.uses==='flow.child'){
      try{expression(s.with.inputs,s,0,true,false,'/steps/'+steps.indexOf(s)+'/inputs');}catch(error){
        if(error instanceof PlanError)throw new PlanError(error.message,error.path==='/'?'/steps/'+steps.indexOf(s)+'/inputs':error.path);
        throw error;
      }
    }else if(s.uses==='flow.foreach'){
      const sourcePath='/steps/'+steps.indexOf(s);
      const check=(value:unknown,path:string,allowItem=false)=>{
        try{expression(value,s,0,false,allowItem,path);}
        catch(error){
          if(error instanceof PlanError)throw new PlanError(error.message,error.path==='/'?path:error.path);
          throw error;
        }
      };
      check(s.with.items,sourcePath+'/items');
      const children=(Array.isArray(s.with.templates)?s.with.templates:[s.with.template]) as
        Array<{id:string;uses:string;with:{data?:unknown;arguments?:unknown};if?:unknown}>;
      for(const [index,child] of children.entries()){
        const childPath=sourcePath+'/template/steps/'+index;
        const localStep={id:child.id,needs:[...s.needs,...children.slice(0,index).map(x=>x.id)]};
        const checkChild=(value:unknown,path:string,opaque=false)=>{
          try{expression(value,localStep,0,opaque,true,path);}
          catch(error){
            if(error instanceof PlanError)throw new PlanError(error.message,error.path==='/'?path:error.path);
            throw error;
          }
        };
        if(child.uses==='mcp.call')
          checkChild(child.with.arguments,childPath+'/with/arguments',true);
        // github.action identity is immutable. Only exact item ref objects in
        // the input map can vary; unsafe nested expressions are not accepted.
        else if(child.uses==='github.run'){
          const a=(child.with as {action:Record<string,unknown>}).action;
          const inputs=a.inputs as Record<string,unknown>;
          for(const [key,value] of Object.entries(inputs))
            if(isForeachTaskInputRef(value))checkChild(value,childPath+'/with/action/inputs/'+key);
        }
        else if(child.with.data!==undefined)
          checkChild(child.with.data,childPath+'/with/data');
        if(child.if!==undefined){
          checkChild(child.if,childPath+'/if');
          const op=child.if&&typeof child.if==='object'&&!Array.isArray(child.if)?Object.keys(child.if):[];
          if(typeof child.if!=='boolean'&&!(op.length===1&&['ref','eq','ne','gt','lt','and','or','not'].includes(op[0])))
            throw new PlanError('invalid_condition',childPath+'/if');
        }
      }
    }else if(s.uses==='http.request'){
      if(Object.hasOwn(s.with,'body')){
        const path='/steps/'+steps.indexOf(s)+'/with/body';
        expression(s.with.body,s,0,true,false,path);
        assertLiteralHttpBody(s.with.body,path);
        if(new TextEncoder().encode(JSON.stringify(s.with.body)).byteLength>4096)
          throw new PlanError('http_body_too_large',path);
      }
    }else if(s.uses==='mcp.call') expression(s.with.arguments,s,0,true,false,'/steps/'+steps.indexOf(s)+'/with/arguments');
    else if(s.uses==='github.run' && s.with.capability==='github.action') {
      // Action identity is an immutable literal, never a runtime expression.
      const a=s.with.action as Record<string,unknown>;
      for(const [key,value] of Object.entries(a)) {
        if(key==='inputs') expression(value,s,0,true,false,'/steps/'+steps.indexOf(s)+'/with/inputs');
        else if(typeof value==='string'&&value.includes('\${{'))throw new PlanError('dynamic_github_identity');
      }
    } else if(s.uses==='action.run'&&s.with.provider==='bark') {
      expression((s.with.input as {notification:unknown}).notification,s,0,true,false,'/steps/'+steps.indexOf(s)+'/with/input/notification');
    } else expression(s.with,s,0,false,false,'/steps/'+steps.indexOf(s)+'/with');
    if(s.if!==undefined){
      expression(s.if,s,0,false,false,'/steps/'+steps.indexOf(s)+'/if');
      const op=s.if && typeof s.if==='object' && !Array.isArray(s.if)?Object.keys(s.if):[];
      if(typeof s.if!=='boolean' && !(op.length===1 && ['ref','eq','ne','gt','lt','and','or','not'].includes(op[0])))throw new PlanError('invalid_condition');
    }
  }
  // Initial reviewed-write slice permits one static external write per Plan.
  // Do not turn a single owner grant into a multi-write fan-out.
  const writeSteps=steps.filter(s=>s.uses==='mcp.call'&&s.with.scope==='write');
  if(writeSteps.length>1)
    throw new PlanError('excessive_mcp_write_steps','/steps');
  const sorted:Step[]=[], pending=new Map(steps.map(s=>[s.id,s]));
  while(pending.size){
    const ready=[...pending.values()].filter(s=>s.needs.every(n=>sorted.some(t=>t.id===n))).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
    if(!ready.length)throw new PlanError('cyclic_dependencies');
    if(ready.length>PLAN_LIMITS.maxParallel)throw new PlanError('excessive_parallelism');
    for(const s of ready){sorted.push(s);pending.delete(s.id);}
  }
  if(saga&&!sorted.some(s=>s.compensate))
    throw new PlanError('saga_requires_compensation','/saga');
  const plan:Plan={version:1,name:o.name,steps:sorted,...(saga?{saga}:{}),...(o.inputs===undefined?{}:{inputs:o.inputs as Record<string,unknown>}),...(triggers?{triggers}:{})};
  const serial=JSON.stringify(canonical(plan));
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(serial));
  const digest=[...new Uint8Array(hash)].map(x=>x.toString(16).padStart(2,'0')).join('');
  return {plan,digest};
}
