import {PlanError} from './plan.ts';
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
export function validateJsonActionInput(schema:unknown,input:unknown,path='/steps',allowRefs=false){
 if(!object(schema)||!object(schema.properties)||!Array.isArray(schema.required)||!object(input))
   throw new PlanError('invalid_json_action_schema',path);
 const fields=schema.properties as Record<string,unknown>;
 if(Object.keys(input).length>32||Object.keys(input).some(k=>!Object.hasOwn(fields,k))||
    schema.required.some(k=>typeof k!=='string'||!Object.hasOwn(input,k))||
    new TextEncoder().encode(JSON.stringify(input)).byteLength>4096)
   throw new PlanError('invalid_json_action_input',path);
 for(const [name,value] of Object.entries(input)){
   const rule=fields[name];
   if(allowRefs&&object(value)&&Object.keys(value).length===1&&typeof value.ref==='string'&&
      /^(?:inputs\.[A-Za-z][A-Za-z0-9_-]{0,63}|steps\.[A-Za-z][A-Za-z0-9_-]{0,63}\.output(?:\.[A-Za-z][A-Za-z0-9_-]{0,63}){1,4})$/.test(value.ref))continue;
   if(!object(rule))throw new PlanError('invalid_json_action_schema',path);
   const type=rule.type;
   if((type==='string'&&typeof value!=='string')||
      (type==='boolean'&&typeof value!=='boolean')||
      (type==='number'&&(typeof value!=='number'||!Number.isFinite(value)))||
      (type==='integer'&&!Number.isSafeInteger(value))||
      !['string','boolean','number','integer',undefined].includes(type as string))
     throw new PlanError('invalid_json_action_input',path+'/'+name);
   if(Array.isArray(rule.enum)&&!rule.enum.includes(value))throw new PlanError('invalid_json_action_input',path+'/'+name);
   if(typeof value==='string'&&(
      typeof rule.minLength==='number'&&value.length<rule.minLength||
      typeof rule.maxLength==='number'&&value.length>rule.maxLength||
      typeof rule.pattern==='string'&&!new RegExp(rule.pattern).test(value)))
      throw new PlanError('invalid_json_action_input',path+'/'+name);
   if(typeof value==='number'&&(
      typeof rule.minimum==='number'&&value<rule.minimum||
      typeof rule.maximum==='number'&&value>rule.maximum))
      throw new PlanError('invalid_json_action_input',path+'/'+name);
 }
}
