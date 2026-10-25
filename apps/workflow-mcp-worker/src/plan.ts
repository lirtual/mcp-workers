import YAML from 'yaml';
import {parseUtcCron, type CronTrigger} from './cron.ts';
import { publicMcpEndpoint } from './mcp-public-fetch.ts';

/** Compiler-owned supported Action kinds; discovery must not invent others. */
export const SUPPORTED_STEP_USES = ['result.emit','mcp.call','github.run'] as const;
export const PLAN_LIMITS = Object.freeze({definitionBytes:32768,maxSteps:32,maxInputs:32,maxParallel:8,maxRepeat:8,maxForeachItems:8});
export function isSupportedStepUse(value:unknown):value is (typeof SUPPORTED_STEP_USES)[number]{
  return typeof value==='string' && (SUPPORTED_STEP_USES as readonly string[]).includes(value);
}

export class PlanError extends Error {
  code = 'invalid_definition';
  path: string;
  constructor(message: string, path = '/') { super(message); this.name = 'PlanError'; this.path = path; }
}
export type Step = {
  id: string; uses: 'result.emit' | 'mcp.call' | 'github.run' | 'flow.foreach'; needs: string[];
  needs_policy?: 'allow_skipped';
  with: Record<string, unknown>; if?: unknown;
};
export type ReadonlyOperation = { endpoint:string; tool:string; scope:'read'; schema_digest:string };
export type WebhookTrigger = {type:'webhook';token_sha256:string};
export type GithubEventTrigger = {type:'github_event';repository:string;repository_id:number;event:'push';ref:string;workflow_path:string};
export const GITHUB_EVENT_PATTERNS=Object.freeze({
  repository:/^(?!.*\.\.)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
  ref:/^refs\/heads\/(?!.*(?:\.\.|\/\/|\/$))[A-Za-z0-9][A-Za-z0-9._\/-]{0,119}$/,
  workflow_path:/^\.github\/workflows\/(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9_.-]{0,100}\.ya?ml$/,
});
export type WorkflowTrigger = CronTrigger | WebhookTrigger | GithubEventTrigger;
export type Plan = { version: 1; name: string; steps: Step[]; inputs?: Record<string, unknown>; triggers?: WorkflowTrigger[]; mcp_approvals?: ReadonlyOperation[]; mcp_target_risks_accepted?: true; github_execution_approved?: true; github_action_approvals?: Array<{repository:string;repositoryId:number;workflowId:number;workflowPath:string;commitSha:string;type:'task'|'session';contractDigest:string}> };
const SAFE_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
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
function refCheck(ref: string, step?: {id:string;needs:string[]}, allowItem=false) {
  const parts=ref.split('.');
  if(parts.length<2 || parts.slice(1).some(p=>!SAFE_ID.test(p)||['__proto__','constructor','prototype'].includes(p))) throw new PlanError('invalid_reference');
  if(parts[0]==='inputs') return;
  if(allowItem&&parts[0]==='item'&&['value','index'].includes(parts[1])&&
     (parts[1]==='value'||parts.length===2))return;
  if(parts[0]==='steps' && step && step.needs.includes(parts[1]) && parts.length>=3 && ['status','output'].includes(parts[2])) return;
  throw new PlanError('invalid_step_reference');
}
function expression(v: unknown, step?: {id:string; needs:string[]}, depth=0, opaqueKeys=false, allowItem=false): void {
  if(depth>15) throw new PlanError('expression_too_deep');
  if(v===null || typeof v==='string'||typeof v==='number'||typeof v==='boolean') return;
  if(Array.isArray(v)) { if(v.length>100) throw new PlanError('expression_too_large'); for(const x of v) expression(x,step,depth+1,opaqueKeys,allowItem); return; }
  const o=object(v,'invalid_expression');
  const names=Object.keys(o);
  if(names.length===1 && names[0]==='ref'){
    if(typeof o.ref!=='string') throw new PlanError('invalid_reference');
    refCheck(o.ref,step,allowItem);return;
  }
  if(names.length===1 && ['eq','ne','gt','lt','and','or','not'].includes(names[0])) {
    const op=names[0], arg=o[op];
    if(op==='not'){expression(arg,step,depth+1,opaqueKeys,allowItem);return;}
    if(!Array.isArray(arg)||arg.length<(op==='and'||op==='or'?1:2)||arg.length>(op==='and'||op==='or'?16:2))throw new PlanError('invalid_operator');
    for(const x of arg)expression(x,step,depth+1,opaqueKeys,allowItem);
    return;
  }
  for(const [name,x] of Object.entries(o)){
    if(name==='__proto__'||name==='prototype'||name==='constructor')throw new PlanError('invalid_argument_key');
    if(!opaqueKeys&&RESERVED.has(name.toLowerCase()))throw new PlanError('unsafe_expression');
    expression(x,step,depth+1,opaqueKeys,allowItem);
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
export async function compilePlan(source: string|unknown): Promise<{plan:Plan; digest:string}>{
  let raw:unknown=source;
  if(typeof source==='string'){
    if(new TextEncoder().encode(source).byteLength>PLAN_LIMITS.definitionBytes)throw new PlanError('definition_too_large');
    try{ const doc=YAML.parseDocument(source,{uniqueKeys:true,strict:true});if(doc.errors.length)throw Error('invalid_yaml');raw=doc.toJS({maxAliasCount:16}); }
    catch{throw new PlanError('invalid_yaml_or_json');}
  }
  validateFiniteNumbers(raw);
  const o=object(raw,'invalid_definition');keys(o,['version','name','inputs','triggers','steps']);
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
  // Literal repeat is compiled to existing, ordered DAG Steps at Publish time.
  // There is no runtime re-evaluation, dynamic item list or second scheduler.
  const expanded:unknown[]=[];
  let foreachReserved=0;
  const foreachChildren=new Set<string>();
  for(let i=0;i<o.steps.length;i++){
    const candidate=object(o.steps[i],'invalid_step');
    if(!Object.hasOwn(candidate,'flow')){
      expanded.push(candidate);
      if(expanded.length+foreachReserved>PLAN_LIMITS.maxSteps)
        throw new PlanError('invalid_step_count','/steps');
      continue;
    }
    const path='/steps/'+i;
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
      const templ=object(candidate.template,'invalid_foreach_template');
      keys(templ,['steps'],path+'/template');
      if(!Array.isArray(templ.steps)||templ.steps.length!==1)
        throw new PlanError('unsupported_foreach_template',path+'/template/steps');
      const child=object(templ.steps[0],'invalid_foreach_template');
      keys(child,['id','uses','with','if'],path+'/template/steps/0');
      if(typeof child.id!=='string'||!SAFE_ID.test(child.id)||
         OBJECT_PROTOTYPE_KEYS.has(child.id))throw new PlanError('invalid_step_id',path+'/template/steps/0/id');
      // External side effects are unsupported in this first snapshot vertical.
      if(child.uses!=='result.emit')
        throw new PlanError('unsupported_foreach_action',path+'/template/steps/0/uses');
      const args=object(child.with,'invalid_step_arguments');
      keys(args,['data'],path+'/template/steps/0/with');
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
      foreachReserved+=Number(candidate.max_items);
      expanded.push({id:candidate.id,uses:'flow.foreach',needs:originalNeeds,
        with:{items:source,max_items:candidate.max_items,template:child}});
      if(expanded.length+foreachReserved>PLAN_LIMITS.maxSteps)
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
    if(!isSupportedStepUse(template.uses))
      throw new PlanError('unsupported_capability',path+'/template/uses');
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
      if(expanded.length+foreachReserved>PLAN_LIMITS.maxSteps)
        throw new PlanError('invalid_step_count','/steps');
    }
  }
  // Ensure no generated dynamic ID can shadow a published Step ID.
  for(const candidate of expanded){
    const id=(candidate as {id?:unknown}).id;
    if(typeof id==='string'&&foreachChildren.has(id))
      throw new PlanError('invalid_step_id','/steps');
  }
  const steps:Step[]=[];
  const ids=new Set<string>();
  for(const s0 of expanded){
    const s=object(s0,'invalid_step');
    const stepPath='/steps/'+steps.length;
    keys(s,['id','uses','needs','needs_policy','if','with'],stepPath);
    if(typeof s.id!=='string'||!SAFE_ID.test(s.id)||ids.has(s.id)||OBJECT_PROTOTYPE_KEYS.has(s.id))throw new PlanError('invalid_step_id');
    ids.add(s.id);
    if(s.uses!=='flow.foreach'&&!isSupportedStepUse(s.uses))throw new PlanError('unsupported_capability',stepPath+'/uses');
    const needs=s.needs===undefined?[]:s.needs;
    if(!Array.isArray(needs)||needs.some(n=>typeof n!=='string'||!SAFE_ID.test(n))||new Set(needs).size!==needs.length)throw new PlanError('invalid_dependencies');
    // Opt-in branch fan-in: completed/skipped dependencies may join, but a
    // failed/indeterminate dependency never authorizes downstream effects.
    if(s.needs_policy!==undefined&&s.needs_policy!=='all_succeeded'&&s.needs_policy!=='allow_skipped')
      throw new PlanError('invalid_needs_policy',stepPath+'/needs_policy');
    if(s.needs_policy==='allow_skipped'&&!needs.length)
      throw new PlanError('invalid_needs_policy',stepPath+'/needs_policy');
    const withData=object(s.with,'invalid_step_arguments');
    if(s.uses==='flow.foreach'){
      keys(withData,['items','max_items','template'],stepPath+'/with');
    }else if(s.uses==='github.run'){
      // A single fixed CI verification operation. No user-supplied scripts,
      // URL, repository, ref or arguments.
      keys(withData,['capability','action'],stepPath+'/with');
      if(withData.capability==='github.action') {
        const action=object(withData.action,'invalid_github_action');
        keys(action,['repository','repositoryId','workflowId','workflowPath','commitSha','type','contractDigest','ref','inputs'],stepPath+'/with/action');
        if(typeof action.repository!=='string'||!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(action.repository)||
           !Number.isSafeInteger(action.repositoryId)||Number(action.repositoryId)<=0||
           !Number.isSafeInteger(action.workflowId)||Number(action.workflowId)<=0||
           typeof action.workflowPath!=='string'||!/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(action.workflowPath)||
           typeof action.commitSha!=='string'||! /^[a-f0-9]{40}$/i.test(action.commitSha)||
           typeof action.ref!=='string'||! /^refs\/tags\/[A-Za-z0-9][A-Za-z0-9._\/-]{0,190}$/.test(action.ref)||
           action.ref.includes('..')||action.ref.includes('//')||action.ref.endsWith('/')||
           !['task','session'].includes(String(action.type))||
           typeof action.contractDigest!=='string'||! /^[a-f0-9]{64}$/i.test(action.contractDigest))
          throw new PlanError('invalid_github_action',stepPath+'/with/action');
        try{object(action.inputs,'invalid_github_action_inputs');}
        catch{throw new PlanError('invalid_github_action_inputs',stepPath+'/with/action/inputs');}
      } else throw new PlanError('unsupported_github_capability');
    }else if(s.uses==='mcp.call'){
      keys(withData,['endpoint','tool','scope','arguments','input_schema','output_schema'],stepPath+'/with');
      if(typeof withData.endpoint!=='string')throw new PlanError('invalid_endpoint',stepPath+'/with/endpoint');
      try { if(publicMcpEndpoint(withData.endpoint).href!==withData.endpoint)throw Error('noncanonical'); }
      catch { throw new PlanError('invalid_endpoint',stepPath+'/with/endpoint'); }
      if(typeof withData.tool!=='string'||!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,127}$/.test(withData.tool))throw new PlanError('invalid_tool',stepPath+'/with/tool');
      if(withData.scope!=='read')throw new PlanError('unsupported_operation_scope',stepPath+'/with/scope');
      object(withData.arguments,'invalid_step_arguments');
      // Only explicit, bounded expected schema objects may be pinned; never a
      // dynamic expression or network-fetched schema silently approved later.
      await toolSchemaDigest(withData.input_schema,withData.output_schema);
    }else keys(withData,['data'],stepPath+'/with');
    const compiledWith=s.uses==='mcp.call'?
      {...withData,schema_digest:await toolSchemaDigest(withData.input_schema,withData.output_schema)}:withData;
    steps.push({id:s.id,uses:s.uses,needs:needs as string[],
      ...(s.needs_policy==='allow_skipped'?{needs_policy:'allow_skipped' as const}:{}),
      with:compiledWith,...(s.if===undefined?{}:{if:s.if})});
  }
  for(const s of steps){
    for(const dep of s.needs)if(!ids.has(dep)||dep===s.id)throw new PlanError('invalid_dependencies');
    if(s.uses==='flow.foreach'){
      expression(s.with.items,s);
      const child=s.with.template as {id:string;uses:string;with:{data?:unknown};if?:unknown};
      if(child.with.data!==undefined)expression(child.with.data,s,0,false,true);
      if(child.if!==undefined){
        expression(child.if,s,0,false,true);
        const op=child.if&&typeof child.if==='object'&&!Array.isArray(child.if)?Object.keys(child.if):[];
        if(typeof child.if!=='boolean'&&!(op.length===1&&['ref','eq','ne','gt','lt','and','or','not'].includes(op[0])))
          throw new PlanError('invalid_condition','/steps/'+steps.indexOf(s)+'/with/template/if');
      }
    }else if(s.uses==='mcp.call') expression(s.with.arguments,s,0,true);
    else if(s.uses==='github.run' && s.with.capability==='github.action') {
      // Action identity is an immutable literal, never a runtime expression.
      const a=s.with.action as Record<string,unknown>;
      for(const [key,value] of Object.entries(a)) {
        if(key==='inputs') expression(value,s,0,true);
        else if(typeof value==='string'&&value.includes('\${{'))throw new PlanError('dynamic_github_identity');
      }
    } else expression(s.with,s);
    if(s.if!==undefined){
      expression(s.if,s);
      const op=s.if && typeof s.if==='object' && !Array.isArray(s.if)?Object.keys(s.if):[];
      if(typeof s.if!=='boolean' && !(op.length===1 && ['ref','eq','ne','gt','lt','and','or','not'].includes(op[0])))throw new PlanError('invalid_condition');
    }
  }
  const sorted:Step[]=[], pending=new Map(steps.map(s=>[s.id,s]));
  while(pending.size){
    const ready=[...pending.values()].filter(s=>s.needs.every(n=>sorted.some(t=>t.id===n))).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
    if(!ready.length)throw new PlanError('cyclic_dependencies');
    if(ready.length>PLAN_LIMITS.maxParallel)throw new PlanError('excessive_parallelism');
    for(const s of ready){sorted.push(s);pending.delete(s.id);}
  }
  const plan:Plan={version:1,name:o.name,steps:sorted,...(o.inputs===undefined?{}:{inputs:o.inputs as Record<string,unknown>}),...(triggers?{triggers}:{})};
  const serial=JSON.stringify(canonical(plan));
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(serial));
  const digest=[...new Uint8Array(hash)].map(x=>x.toString(16).padStart(2,'0')).join('');
  return {plan,digest};
}
