import YAML from 'yaml';
import { publicMcpEndpoint } from './mcp-public-fetch.ts';
import {
  CONDITION_VALUE_OPS, DEFINITION_KEYS, GITHUB_CAPABILITY_ID, GITHUB_TRIGGER_EVENTS, GITHUB_TRIGGER_KEYS,
  isSupportedUse, LIMITS, MCP_SCOPE, OBJECT_PROTOTYPE_KEYS, RESERVED_EXPRESSION_KEYS, STEP_ID, STEP_KEYS,
  TOOL_NAME, TRIGGER_EVENT_NAME, TRIGGER_REPOSITORY, TRIGGER_SOURCE_ID, WEBHOOK_TRIGGER_KEYS, WITH_KEYS,
} from './capabilities.ts';

export class PlanError extends Error {
  code = 'invalid_definition';
  readonly path?: string;
  readonly suggestion?: string;
  constructor(message: string, hint?: {path?: string; suggestion?: string}) {
    super(message); this.name = 'PlanError'; this.path = hint?.path; this.suggestion = hint?.suggestion;
  }
}
export type Step = {
  id: string; uses: 'result.emit' | 'mcp.call' | 'github.run'; needs: string[];
  with: Record<string, unknown>; if?: unknown;
};
export type ReadonlyOperation = { endpoint:string; tool:string; scope:'read'; schema_digest:string };
export type WebhookTrigger = { id: string; type: 'webhook'; source: string; event: string };
export type GithubEventTrigger = { id: string; type: 'github_event'; repository: string; events: string[] };
export type PlanTrigger = WebhookTrigger | GithubEventTrigger;
export type Plan = { version: 1; name: string; steps: Step[]; inputs?: Record<string, unknown>; triggers?: PlanTrigger[]; mcp_approvals?: ReadonlyOperation[]; mcp_target_risks_accepted?: true; github_execution_approved?: true };
const PROTOTYPE_KEYS = new Set<string>(OBJECT_PROTOTYPE_KEYS);
const RESERVED = new Set<string>(RESERVED_EXPRESSION_KEYS);
function pointer(base: string, key: string | number): string {
  return base + '/' + String(key).replace(/~/g, '~0').replace(/\//g, '~1');
}
const keys = (o: Record<string, unknown>, allowed: readonly string[], path: string) => {
  for(const key of Object.keys(o)) if(!allowed.includes(key)) throw new PlanError('unsupported_field:'+key, {
    path: pointer(path, key), suggestion: 'Remove this field.',
  });
};
function object(value: unknown, message: string, path?: string): Record<string, unknown> {
  if(!value || typeof value !== 'object' || Array.isArray(value)) throw new PlanError(message, path === undefined ? undefined : {path});
  return value as Record<string, unknown>;
}
function refCheck(ref: string, step?: {id:string;needs:string[]}, path?: string) {
  const hint = {path, suggestion: 'Use inputs.<id> or steps.<needed-step>.status or steps.<needed-step>.output.'};
  const parts=ref.split('.');
  if(parts.length<2 || parts.slice(1).some(p=>!STEP_ID.test(p)||['__proto__','constructor','prototype'].includes(p))) throw new PlanError('invalid_reference', hint);
  if(parts[0]==='inputs') return;
  if(parts[0]==='steps' && step && step.needs.includes(parts[1]) && parts.length>=3 && ['status','output'].includes(parts[2])) return;
  throw new PlanError('invalid_step_reference', hint);
}
function expression(v: unknown, step?: {id:string; needs:string[]}, depth=0, opaqueKeys=false, path=''): void {
  if(depth>LIMITS.maxExpressionDepth) throw new PlanError('expression_too_deep', {path: path || '/'});
  if(v===null || typeof v==='string'||typeof v==='number'||typeof v==='boolean') return;
  if(Array.isArray(v)) {
    if(v.length>LIMITS.maxArrayLength) throw new PlanError('expression_too_large', {path: path || '/'});
    for(let index=0; index<v.length; index++) expression(v[index],step,depth+1,opaqueKeys,pointer(path,index));
    return;
  }
  const o=object(v,'invalid_expression', path || '/');
  const names=Object.keys(o);
  if(names.length===1 && names[0]==='ref'){
    if(typeof o.ref!=='string') throw new PlanError('invalid_reference', {path: pointer(path,'ref'), suggestion: 'Use inputs.<id> or steps.<needed-step>.status or steps.<needed-step>.output.'});
    refCheck(o.ref,step,pointer(path,'ref'));return;
  }
  if(names.length===1 && (CONDITION_VALUE_OPS as readonly string[]).includes(names[0])) {
    const op=names[0], arg=o[op];
    if(op==='not'){expression(arg,step,depth+1,opaqueKeys,pointer(path,op));return;}
    const min=op==='and'||op==='or'?LIMITS.minLogicOperands:LIMITS.comparisonOperands;
    const max=op==='and'||op==='or'?LIMITS.maxLogicOperands:LIMITS.comparisonOperands;
    if(!Array.isArray(arg)||arg.length<min||arg.length>max)throw new PlanError('invalid_operator', {path: pointer(path,op)});
    for(let index=0; index<arg.length; index++) expression(arg[index],step,depth+1,opaqueKeys,pointer(pointer(path,op),index));
    return;
  }
  for(const [name,x] of Object.entries(o)){
    if(name==='__proto__'||name==='prototype'||name==='constructor')throw new PlanError('invalid_argument_key', {path: pointer(path,name)});
    if(!opaqueKeys&&RESERVED.has(name.toLowerCase()))throw new PlanError('unsafe_expression', {path: pointer(path,name), suggestion: 'Remove this expression field.'});
    expression(x,step,depth+1,opaqueKeys,pointer(path,name));
  }
}
// YAML accepts .nan/.inf, but JSON persistence silently changes them to null.
// Reject these before computing an immutable Published Plan digest.
function validateFiniteNumbers(v: unknown, depth=0, path=''): void {
  if(depth>LIMITS.maxDefinitionDepth)throw new PlanError('definition_too_deep', {path: path || '/'});
  if(typeof v==='number' && !Number.isFinite(v))throw new PlanError('non_finite_number', {path: path || '/'});
  if(Array.isArray(v)) {for(let index=0; index<v.length; index++)validateFiniteNumbers(v[index],depth+1,pointer(path,index));}
  else if(v && typeof v==='object') {
    for(const [key,child] of Object.entries(v))validateFiniteNumbers(child,depth+1,pointer(path,key));
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
  if(new TextEncoder().encode(serial).byteLength>LIMITS.maxToolSchemaBytes)throw new PlanError('tool_schema_too_large');
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(serial));
  return [...new Uint8Array(hash)].map(v=>v.toString(16).padStart(2,'0')).join('');
}
export function evaluateExpression(v: unknown, ctx: {inputs:Record<string,unknown>;steps:Record<string,{status:string;output?:unknown}>}): any {
  if(Array.isArray(v))return v.map(x=>evaluateExpression(x,ctx));
  if(v===null||typeof v!=='object')return v;
  const o=v as Record<string,unknown>;
  if(Object.keys(o).length===1){
    if('ref' in o) {let parts=String(o.ref).split('.');let value:any=parts[0]==='inputs'?ctx.inputs:ctx.steps; for(const p of parts.slice(1)) {if(value===null||(typeof value!=='object'&&typeof value!=='function')||!Object.hasOwn(value,p))return undefined;value=value[p];}return value;}
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
export function evaluateCondition(condition: unknown, ctx: {inputs:Record<string,unknown>;steps:Record<string,{status:string;output?:unknown}>}): boolean {
  const value=evaluateExpression(condition,ctx);
  if(typeof value!=='boolean')throw new PlanError('non_boolean_condition');
  return value;
}
export const evaluateArguments=evaluateExpression;
function validateTriggers(value: unknown): PlanTrigger[] {
  if(!Array.isArray(value)||value.length<1||value.length>LIMITS.maxTriggers)
    throw new PlanError('invalid_trigger', {path:'/triggers', suggestion:'Declare one webhook, one github_event, or both.'});
  const triggers: PlanTrigger[]=[];
  const ids=new Set<string>();
  const types=new Set<string>();
  for(let index=0; index<value.length; index++){
    const path='/triggers/'+index;
    const trigger=object(value[index],'invalid_trigger',path);
    if(trigger.type!=='webhook'&&trigger.type!=='github_event')
      throw new PlanError('invalid_trigger', {path:path+'/type', suggestion:'Use webhook or github_event.'});
    if(typeof trigger.id!=='string'||!STEP_ID.test(trigger.id)||ids.has(trigger.id))
      throw new PlanError('invalid_trigger', {path:path+'/id'});
    if(types.has(trigger.type))throw new PlanError('duplicate_trigger', {path:path+'/type'});
    ids.add(trigger.id); types.add(trigger.type);
    if(trigger.type==='webhook'){
      keys(trigger,WEBHOOK_TRIGGER_KEYS,path);
      if(typeof trigger.source!=='string'||!TRIGGER_SOURCE_ID.test(trigger.source))
        throw new PlanError('invalid_trigger_source', {path:path+'/source', suggestion:'Use the configured source id. Do not put a URL in source.'});
      if(typeof trigger.event!=='string'||!TRIGGER_EVENT_NAME.test(trigger.event))
        throw new PlanError('invalid_trigger_event', {path:path+'/event'});
      triggers.push({id:trigger.id,type:'webhook',source:trigger.source,event:trigger.event});
      continue;
    }
    keys(trigger,GITHUB_TRIGGER_KEYS,path);
    if(typeof trigger.repository!=='string'||!TRIGGER_REPOSITORY.test(trigger.repository)||trigger.repository.includes('..'))
      throw new PlanError('invalid_repository', {path:path+'/repository', suggestion:'Use owner/name.'});
    if(!Array.isArray(trigger.events)||trigger.events.length<1||trigger.events.length>LIMITS.maxTriggerEvents)
      throw new PlanError('invalid_trigger_event', {path:path+'/events'});
    const events:string[]=[];
    for(let eventIndex=0; eventIndex<trigger.events.length; eventIndex++){
      const event=trigger.events[eventIndex];
      const eventPath=path+'/events/'+eventIndex;
      if(typeof event!=='string'||!TRIGGER_EVENT_NAME.test(event))
        throw new PlanError('invalid_trigger_event', {path:eventPath});
      if(!(GITHUB_TRIGGER_EVENTS as readonly string[]).includes(event))
        throw new PlanError('unsupported_github_event', {
          path:eventPath, suggestion:'Use push, issues, issue_comment, pull_request, release, create, or delete.',
        });
      if(events.includes(event))throw new PlanError('duplicate_trigger', {path:eventPath});
      events.push(event);
    }
    events.sort();
    triggers.push({id:trigger.id,type:'github_event',repository:trigger.repository,events});
  }
  triggers.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  return triggers;
}
export async function compilePlan(source: string|unknown): Promise<{plan:Plan; digest:string}>{
  let raw:unknown=source;
  if(typeof source==='string'){
    if(new TextEncoder().encode(source).byteLength>LIMITS.definitionBytes)throw new PlanError('definition_too_large', {path: '/'});
    try{ const doc=YAML.parseDocument(source,{uniqueKeys:true,strict:true});if(doc.errors.length)throw Error('invalid_yaml');raw=doc.toJS({maxAliasCount:LIMITS.maxAliasCount}); }
    catch{throw new PlanError('invalid_yaml_or_json', {path: '/'});}
  }
  validateFiniteNumbers(raw);
  const o=object(raw,'invalid_definition','/');keys(o,DEFINITION_KEYS,'');
  if(o.version!==1)throw new PlanError('invalid_version', {path: '/version'});
  if(typeof o.name!=='string'||!o.name.trim()||o.name.length>LIMITS.maxNameLength)throw new PlanError('invalid_name', {path: '/name'});
  if(!Array.isArray(o.steps)||o.steps.length<LIMITS.minSteps||o.steps.length>LIMITS.maxSteps)throw new PlanError('invalid_step_count', {path: '/steps'});
  if(o.inputs!==undefined) {const inp=object(o.inputs,'invalid_inputs','/inputs');if(Object.keys(inp).length>LIMITS.maxInputs)throw new PlanError('too_many_inputs', {path: '/inputs'});}
  const triggers=o.triggers===undefined?undefined:validateTriggers(o.triggers);
  const steps:Step[]=[];
  const ids=new Set<string>();
  for(let index=0; index<o.steps.length; index++){
    const stepPath='/steps/'+index;
    const s=object(o.steps[index],'invalid_step',stepPath);keys(s,STEP_KEYS,stepPath);
    if(typeof s.id!=='string'||!STEP_ID.test(s.id)||ids.has(s.id)||PROTOTYPE_KEYS.has(s.id))throw new PlanError('invalid_step_id', {path: stepPath+'/id'});
    ids.add(s.id);
    if(!isSupportedUse(s.uses))throw new PlanError('unsupported_capability', {
      path: stepPath+'/uses', suggestion: 'Use result.emit, mcp.call, or github.run.',
    });
    const needs=s.needs===undefined?[]:s.needs;
    if(!Array.isArray(needs)||needs.some(n=>typeof n!=='string'||!STEP_ID.test(n))||new Set(needs).size!==needs.length)throw new PlanError('invalid_dependencies', {path: stepPath+'/needs'});
    const withData=object(s.with,'invalid_step_arguments',stepPath+'/with');
    if(s.uses==='github.run'){
      // A single fixed CI verification operation. No user-supplied scripts,
      // URL, repository, ref or arguments.
      keys(withData,WITH_KEYS['github.run'],stepPath+'/with');
      if(withData.capability!==GITHUB_CAPABILITY_ID)
        throw new PlanError('unsupported_github_capability', {
          path: stepPath+'/with/capability', suggestion: 'Set capability to github.workflow.check.',
        });
    }else if(s.uses==='mcp.call'){
      keys(withData,WITH_KEYS['mcp.call'],stepPath+'/with');
      if(typeof withData.endpoint!=='string')throw new PlanError('invalid_endpoint', {path: stepPath+'/with/endpoint'});
      try { if(publicMcpEndpoint(withData.endpoint).href!==withData.endpoint)throw Error('noncanonical'); }
      catch { throw new PlanError('invalid_endpoint', {path: stepPath+'/with/endpoint', suggestion: 'Use the configured portal HTTPS URL with no userinfo, fragment, or non-443 port.'}); }
      if(typeof withData.tool!=='string'||!TOOL_NAME.test(withData.tool))throw new PlanError('invalid_tool', {path: stepPath+'/with/tool'});
      if(withData.scope!==MCP_SCOPE)throw new PlanError('unsupported_operation_scope', {
        path: stepPath+'/with/scope', suggestion: 'Set scope to read.',
      });
      object(withData.arguments,'invalid_step_arguments',stepPath+'/with/arguments');
      // Only explicit, bounded expected schema objects may be pinned; never a
      // dynamic expression or network-fetched schema silently approved later.
      try{await toolSchemaDigest(withData.input_schema,withData.output_schema);}
      catch(error){if(error instanceof PlanError)throw new PlanError(error.message,{path:stepPath+'/with'});throw error;}
    }else keys(withData,WITH_KEYS['result.emit'],stepPath+'/with');
    const compiledWith=s.uses==='mcp.call'?
      {...withData,schema_digest:await toolSchemaDigest(withData.input_schema,withData.output_schema)}:withData;
    steps.push({id:s.id,uses:s.uses,needs:needs as string[],with:compiledWith,...(s.if===undefined?{}:{if:s.if})});
  }
  for(let index=0; index<steps.length; index++){
    const s=steps[index], stepPath='/steps/'+index;
    for(const dep of s.needs)if(!ids.has(dep)||dep===s.id)throw new PlanError('invalid_dependencies', {path: stepPath+'/needs'});
    if(s.uses==='mcp.call') expression(s.with.arguments,s,0,true,stepPath+'/with/arguments');
    else expression(s.with,s,0,false,stepPath+'/with');
    if(s.if!==undefined){
      expression(s.if,s,0,false,stepPath+'/if');
      const op=s.if && typeof s.if==='object' && !Array.isArray(s.if)?Object.keys(s.if):[];
      if(typeof s.if!=='boolean' && !(op.length===1 && (CONDITION_VALUE_OPS as readonly string[]).concat('ref').includes(op[0])))throw new PlanError('invalid_condition', {path: stepPath+'/if'});
    }
  }
  const sorted:Step[]=[], pending=new Map(steps.map(s=>[s.id,s]));
  while(pending.size){
    const ready=[...pending.values()].filter(s=>s.needs.every(n=>sorted.some(t=>t.id===n))).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
    if(!ready.length)throw new PlanError('cyclic_dependencies', {path: '/steps'});
    if(ready.length>LIMITS.maxParallel)throw new PlanError('excessive_parallelism', {path: '/steps', suggestion: 'Keep each ready wave to 8 steps or fewer.'});
    for(const s of ready){sorted.push(s);pending.delete(s.id);}
  }
  const plan:Plan={version:1,name:o.name,steps:sorted,...(o.inputs===undefined?{}:{inputs:o.inputs as Record<string,unknown>}),...(triggers===undefined?{}:{triggers})};
  const serial=JSON.stringify(canonical(plan));
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(serial));
  const digest=[...new Uint8Array(hash)].map(x=>x.toString(16).padStart(2,'0')).join('');
  return {plan,digest};
}
