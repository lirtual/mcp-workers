import YAML from 'yaml';
import { publicMcpEndpoint } from './mcp-public-fetch.ts';

export class PlanError extends Error {
  code = 'invalid_definition';
  constructor(message: string) { super(message); this.name = 'PlanError'; }
}
export type Step = {
  id: string; uses: 'result.emit' | 'mcp.call' | 'github.run'; needs: string[];
  with: Record<string, unknown>; if?: unknown;
};
export type ReadonlyOperation = { endpoint:string; tool:string; scope:'read'; schema_digest:string };
export type Plan = { version: 1; name: string; steps: Step[]; inputs?: Record<string, unknown>; mcp_approvals?: ReadonlyOperation[]; mcp_target_risks_accepted?: true; github_execution_approved?: true; github_action_approvals?: Array<{repository:string;repositoryId:number;workflowId:number;workflowPath:string;commitSha:string;type:'task'|'session';contractDigest:string}> };
const SAFE_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const OBJECT_PROTOTYPE_KEYS = new Set(['constructor','toString','toLocaleString','valueOf','hasOwnProperty','isPrototypeOf','propertyIsEnumerable']);
const RESERVED = new Set(['eval','javascript','script','code','shell','endpoint','url','command','function']);
const keys = (o: Record<string, unknown>, allowed: string[]) => {
  for(const key of Object.keys(o)) if(!allowed.includes(key)) throw new PlanError('unsupported_field:'+key);
};
function object(value: unknown, message: string): Record<string, unknown> {
  if(!value || typeof value !== 'object' || Array.isArray(value)) throw new PlanError(message);
  return value as Record<string, unknown>;
}
function refCheck(ref: string, step?: {id:string;needs:string[]}) {
  const parts=ref.split('.');
  if(parts.length<2 || parts.slice(1).some(p=>!SAFE_ID.test(p)||['__proto__','constructor','prototype'].includes(p))) throw new PlanError('invalid_reference');
  if(parts[0]==='inputs') return;
  if(parts[0]==='steps' && step && step.needs.includes(parts[1]) && parts.length>=3 && ['status','output'].includes(parts[2])) return;
  throw new PlanError('invalid_step_reference');
}
function expression(v: unknown, step?: {id:string; needs:string[]}, depth=0, opaqueKeys=false): void {
  if(depth>15) throw new PlanError('expression_too_deep');
  if(v===null || typeof v==='string'||typeof v==='number'||typeof v==='boolean') return;
  if(Array.isArray(v)) { if(v.length>100) throw new PlanError('expression_too_large'); for(const x of v) expression(x,step,depth+1,opaqueKeys); return; }
  const o=object(v,'invalid_expression');
  const names=Object.keys(o);
  if(names.length===1 && names[0]==='ref'){
    if(typeof o.ref!=='string') throw new PlanError('invalid_reference');
    refCheck(o.ref,step);return;
  }
  if(names.length===1 && ['eq','ne','gt','lt','and','or','not'].includes(names[0])) {
    const op=names[0], arg=o[op];
    if(op==='not'){expression(arg,step,depth+1,opaqueKeys);return;}
    if(!Array.isArray(arg)||arg.length<(op==='and'||op==='or'?1:2)||arg.length>(op==='and'||op==='or'?16:2))throw new PlanError('invalid_operator');
    for(const x of arg)expression(x,step,depth+1,opaqueKeys);
    return;
  }
  for(const [name,x] of Object.entries(o)){
    if(name==='__proto__'||name==='prototype'||name==='constructor')throw new PlanError('invalid_argument_key');
    if(!opaqueKeys&&RESERVED.has(name.toLowerCase()))throw new PlanError('unsafe_expression');
    expression(x,step,depth+1,opaqueKeys);
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
export async function compilePlan(source: string|unknown): Promise<{plan:Plan; digest:string}>{
  let raw:unknown=source;
  if(typeof source==='string'){
    if(new TextEncoder().encode(source).byteLength>32*1024)throw new PlanError('definition_too_large');
    try{ const doc=YAML.parseDocument(source,{uniqueKeys:true,strict:true});if(doc.errors.length)throw Error('invalid_yaml');raw=doc.toJS({maxAliasCount:16}); }
    catch{throw new PlanError('invalid_yaml_or_json');}
  }
  validateFiniteNumbers(raw);
  const o=object(raw,'invalid_definition');keys(o,['version','name','inputs','steps']);
  if(o.version!==1)throw new PlanError('invalid_version');
  if(typeof o.name!=='string'||!o.name.trim()||o.name.length>120)throw new PlanError('invalid_name');
  if(!Array.isArray(o.steps)||o.steps.length<1||o.steps.length>32)throw new PlanError('invalid_step_count');
  if(o.inputs!==undefined) {const inp=object(o.inputs,'invalid_inputs');if(Object.keys(inp).length>32)throw new PlanError('too_many_inputs');}
  const steps:Step[]=[];
  const ids=new Set<string>();
  for(const s0 of o.steps){
    const s=object(s0,'invalid_step');keys(s,['id','uses','needs','if','with']);
    if(typeof s.id!=='string'||!SAFE_ID.test(s.id)||ids.has(s.id)||OBJECT_PROTOTYPE_KEYS.has(s.id))throw new PlanError('invalid_step_id');
    ids.add(s.id);
    if(s.uses!=='result.emit'&&s.uses!=='mcp.call'&&s.uses!=='github.run')throw new PlanError('unsupported_capability');
    const needs=s.needs===undefined?[]:s.needs;
    if(!Array.isArray(needs)||needs.some(n=>typeof n!=='string'||!SAFE_ID.test(n))||new Set(needs).size!==needs.length)throw new PlanError('invalid_dependencies');
    const withData=object(s.with,'invalid_step_arguments');
    if(s.uses==='github.run'){
      // A single fixed CI verification operation. No user-supplied scripts,
      // URL, repository, ref or arguments.
      keys(withData,['capability','action']);
      if(withData.capability==='github.action') {
        const action=object(withData.action,'invalid_github_action');
        keys(action,['repository','repositoryId','workflowId','workflowPath','commitSha','type','contractDigest','inputs']);
        if(typeof action.repository!=='string'||!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(action.repository)||
           !Number.isSafeInteger(action.repositoryId)||Number(action.repositoryId)<=0||
           !Number.isSafeInteger(action.workflowId)||Number(action.workflowId)<=0||
           typeof action.workflowPath!=='string'||!/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(action.workflowPath)||
           typeof action.commitSha!=='string'||! /^[a-f0-9]{40}$/i.test(action.commitSha)||
           !['task','session'].includes(String(action.type))||
           typeof action.contractDigest!=='string'||! /^[a-f0-9]{64}$/i.test(action.contractDigest))
          throw new PlanError('invalid_github_action');
        object(action.inputs,'invalid_github_action_inputs');
      } else if(withData.capability!=='github.workflow.check')
        throw new PlanError('unsupported_github_capability');
    }else if(s.uses==='mcp.call'){
      keys(withData,['endpoint','tool','scope','arguments','input_schema','output_schema']);
      if(typeof withData.endpoint!=='string')throw new PlanError('invalid_endpoint');
      try { if(publicMcpEndpoint(withData.endpoint).href!==withData.endpoint)throw Error('noncanonical'); }
      catch { throw new PlanError('invalid_endpoint'); }
      if(typeof withData.tool!=='string'||!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,127}$/.test(withData.tool))throw new PlanError('invalid_tool');
      if(withData.scope!=='read')throw new PlanError('unsupported_operation_scope');
      object(withData.arguments,'invalid_step_arguments');
      // Only explicit, bounded expected schema objects may be pinned; never a
      // dynamic expression or network-fetched schema silently approved later.
      await toolSchemaDigest(withData.input_schema,withData.output_schema);
    }else keys(withData,['data']);
    const compiledWith=s.uses==='mcp.call'?
      {...withData,schema_digest:await toolSchemaDigest(withData.input_schema,withData.output_schema)}:withData;
    steps.push({id:s.id,uses:s.uses,needs:needs as string[],with:compiledWith,...(s.if===undefined?{}:{if:s.if})});
  }
  for(const s of steps){
    for(const dep of s.needs)if(!ids.has(dep)||dep===s.id)throw new PlanError('invalid_dependencies');
    if(s.uses==='mcp.call') expression(s.with.arguments,s,0,true);
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
    if(ready.length>8)throw new PlanError('excessive_parallelism');
    for(const s of ready){sorted.push(s);pending.delete(s.id);}
  }
  const plan:Plan={version:1,name:o.name,steps:sorted,...(o.inputs===undefined?{}:{inputs:o.inputs as Record<string,unknown>})};
  const serial=JSON.stringify(canonical(plan));
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(serial));
  const digest=[...new Uint8Array(hash)].map(x=>x.toString(16).padStart(2,'0')).join('');
  return {plan,digest};
}
