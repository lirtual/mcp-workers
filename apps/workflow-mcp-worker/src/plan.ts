import YAML from 'yaml';

export class PlanError extends Error {
  code = 'invalid_definition';
  constructor(message: string) { super(message); this.name = 'PlanError'; }
}
export type Step = {
  id: string; uses: 's1.readonly_mcp' | 'result.emit'; needs: string[];
  with: Record<string, unknown>; if?: unknown;
};
export type Plan = { version: 1; name: string; steps: Step[]; inputs?: Record<string, unknown> };
const SAFE_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
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
  if(parts.length<2 || !SAFE_ID.test(parts[1])) throw new PlanError('invalid_reference');
  if(parts[0]==='inputs') return;
  if(parts[0]==='steps' && step && step.needs.includes(parts[1]) && parts.length>=3 && ['status','output'].includes(parts[2])) return;
  throw new PlanError('invalid_step_reference');
}
function expression(v: unknown, step?: {id:string; needs:string[]}, depth=0): void {
  if(depth>15) throw new PlanError('expression_too_deep');
  if(v===null || typeof v==='string'||typeof v==='number'||typeof v==='boolean') return;
  if(Array.isArray(v)) { if(v.length>100) throw new PlanError('expression_too_large'); for(const x of v) expression(x,step,depth+1); return; }
  const o=object(v,'invalid_expression');
  const names=Object.keys(o);
  if(names.length===1 && names[0]==='ref'){
    if(typeof o.ref!=='string') throw new PlanError('invalid_reference');
    refCheck(o.ref,step);return;
  }
  if(names.length===1 && ['eq','ne','gt','lt','and','or','not'].includes(names[0])) {
    const op=names[0], arg=o[op];
    if(op==='not'){expression(arg,step,depth+1);return;}
    if(!Array.isArray(arg)||arg.length<(op==='and'||op==='or'?1:2)||arg.length>(op==='and'||op==='or'?16:2))throw new PlanError('invalid_operator');
    for(const x of arg)expression(x,step,depth+1);
    return;
  }
  for(const [name,x] of Object.entries(o)){
    if(RESERVED.has(name.toLowerCase()))throw new PlanError('unsafe_expression');
    expression(x,step,depth+1);
  }
}
function canonical(v: unknown): unknown {
  if(Array.isArray(v)) return v.map(canonical);
  if(v && typeof v==='object') return Object.fromEntries(Object.entries(v as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,canonical(x)]));
  return v;
}
export function evaluateExpression(v: unknown, ctx: {inputs:Record<string,unknown>;steps:Record<string,{status:string;output?:unknown}>}): any {
  if(Array.isArray(v))return v.map(x=>evaluateExpression(x,ctx));
  if(v===null||typeof v!=='object')return v;
  const o=v as Record<string,unknown>;
  if(Object.keys(o).length===1){
    if('ref' in o) {let parts=String(o.ref).split('.');let value:any=parts[0]==='inputs'?ctx.inputs:ctx.steps; for(const p of parts.slice(1))value=value?.[p];return value;}
    if('eq' in o) {const [a,b]=(o.eq as unknown[]).map(x=>evaluateExpression(x,ctx));return a===b;}
    if('ne' in o) {const [a,b]=(o.ne as unknown[]).map(x=>evaluateExpression(x,ctx));return a!==b;}
    if('gt' in o) {const [a,b]=(o.gt as unknown[]).map(x=>evaluateExpression(x,ctx));return typeof a==='number'&&typeof b==='number'&&a>b;}
    if('lt' in o) {const [a,b]=(o.lt as unknown[]).map(x=>evaluateExpression(x,ctx));return typeof a==='number'&&typeof b==='number'&&a<b;}
    if('and' in o)return (o.and as unknown[]).every(x=>Boolean(evaluateExpression(x,ctx)));
    if('or' in o)return (o.or as unknown[]).some(x=>Boolean(evaluateExpression(x,ctx)));
    if('not' in o)return !Boolean(evaluateExpression(o.not,ctx));
  }
  return Object.fromEntries(Object.entries(o).map(([k,x])=>[k,evaluateExpression(x,ctx)]));
}
export const evaluateArguments=evaluateExpression;
export async function compilePlan(source: string|unknown): Promise<{plan:Plan; digest:string}>{
  let raw:unknown=source;
  if(typeof source==='string'){
    if(source.length>32*1024)throw new PlanError('definition_too_large');
    try{ const doc=YAML.parseDocument(source,{uniqueKeys:true,strict:true});if(doc.errors.length)throw Error('invalid_yaml');raw=doc.toJS(); }
    catch{throw new PlanError('invalid_yaml_or_json');}
  }
  const o=object(raw,'invalid_definition');keys(o,['version','name','inputs','steps']);
  if(o.version!==1)throw new PlanError('invalid_version');
  if(typeof o.name!=='string'||!o.name.trim()||o.name.length>120)throw new PlanError('invalid_name');
  if(!Array.isArray(o.steps)||o.steps.length<1||o.steps.length>32)throw new PlanError('invalid_step_count');
  if(o.inputs!==undefined) {const inp=object(o.inputs,'invalid_inputs');if(Object.keys(inp).length>32)throw new PlanError('too_many_inputs');}
  const steps:Step[]=[];
  const ids=new Set<string>();
  for(const s0 of o.steps){
    const s=object(s0,'invalid_step');keys(s,['id','uses','needs','if','with']);
    if(typeof s.id!=='string'||!SAFE_ID.test(s.id)||ids.has(s.id))throw new PlanError('invalid_step_id');
    ids.add(s.id);
    if(s.uses!=='s1.readonly_mcp'&&s.uses!=='result.emit')throw new PlanError('unsupported_capability');
    const needs=s.needs===undefined?[]:s.needs;
    if(!Array.isArray(needs)||needs.some(n=>typeof n!=='string'||!SAFE_ID.test(n))||new Set(needs).size!==needs.length)throw new PlanError('invalid_dependencies');
    const withData=object(s.with,'invalid_step_arguments');
    if(s.uses==='s1.readonly_mcp'){
      keys(withData,['tool','arguments']);
      if(withData.tool!=='echo')throw new PlanError('unsupported_readonly_tool');
      if(withData.arguments===undefined)throw new PlanError('missing_arguments');
    }else keys(withData,['data']);
    steps.push({id:s.id,uses:s.uses,needs:needs as string[],with:withData,...(s.if===undefined?{}:{if:s.if})});
  }
  for(const s of steps){
    for(const dep of s.needs)if(!ids.has(dep)||dep===s.id)throw new PlanError('invalid_dependencies');
    expression(s.with,s);
    if(s.if!==undefined)expression(s.if,s);
  }
  const sorted:Step[]=[], pending=new Map(steps.map(s=>[s.id,s]));
  while(pending.size){
    const ready=[...pending.values()].filter(s=>s.needs.every(n=>sorted.some(t=>t.id===n))).sort((a,b)=>a.id.localeCompare(b.id));
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
