import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkflowService} from '../src/store.ts';
import {canonical} from '../src/cloudflare-action-contract.ts';
const deployment='11111111-1111-4111-8111-111111111111';
const manifest={executor:'cloudflare',provider:'json',action:'json.report',version:1,
 source_repository:'lirtual/cloudflare-actions',service:'cloudflare-actions',entrypoint:'ActionsEntrypoint',
 side_effect:'none',input_schema:{type:'object',additionalProperties:false,
  required:['message'],properties:{message:{type:'string',maxLength:100}}},
 output_schema:{type:'object',additionalProperties:false,
  required:['status'],properties:{status:{enum:['accepted','rejected','unknown']}}},
};
const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(canonical(manifest))));
const contract_digest=Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('');
const provider={listActions:async()=>[{action_id:'json.report'}],
 getContract:async()=>({manifest,contract_digest,deployment_id:deployment})};
const service=new WorkflowService({ACTIONS:provider} as any);
const definition=(input:unknown)=>JSON.stringify({version:1,name:'report',steps:[{
 id:'report',uses:'action.run',with:{action_id:'json.report',input},
}]});
test('single action_id compiles to reviewed Cloudflare JSON Action and persists contract',async()=>{
 const result=await service.validateDefinition(definition({message:'hello'}));
 assert.equal(result.valid,true,JSON.stringify(result));
 assert.equal('reviewed_cloudflare_actions' in result ? result.reviewed_cloudflare_actions?.[0]?.action : undefined,'json.report');
});
test('a new side effect compiles from the Provider contract without a Consumer name',async()=>{
 const marked={...manifest,action:'json.mark',side_effect:'record_audited_marker'};
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(canonical(marked))));
 const markedDigest=Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');
 const markedProvider={listActions:async()=>[{action_id:'json.mark'}],
  getContract:async()=>({manifest:marked,contract_digest:markedDigest,deployment_id:deployment})};
 const markedService=new WorkflowService({ACTIONS:markedProvider} as any);
 const result=await markedService.validateDefinition(JSON.stringify({version:1,name:'mark',steps:[{
  id:'mark',uses:'action.run',with:{action_id:'json.mark',input:{message:'hello'}},
 }]}));
 assert.equal(result.valid,true,JSON.stringify(result));
 assert.equal('reviewed_cloudflare_actions' in result?result.reviewed_cloudflare_actions?.[0]?.action:undefined,'json.mark');
});
test('generic input rejects extra fields and missing required fields before Publish',async()=>{
 for(const input of [{message:'ok',secret:'unreviewed'},{wrong:'missing'},
  {message:'x'.repeat(101)}]){
   const result=await service.validateDefinition(definition(input));
   assert.equal(result.valid,false,JSON.stringify(result));
 }
});

test('input references from Run are allowed but undeclared output fields are not',async()=>{
 const variable=await service.validateDefinition(definition({message:{ref:'inputs.message'}}));
 assert.equal(variable.valid,true,JSON.stringify(variable));
 const leak=JSON.stringify({version:1,name:'report',steps:[
  {id:'report',uses:'action.run',with:{action_id:'json.report',input:{message:'hello'}}},
  {id:'emit',uses:'result.emit',needs:['report'],with:{data:{ref:'steps.report.output.secret'}}},
 ]});
 const rejected=await service.validateDefinition(leak);
 assert.equal(rejected.valid,false,JSON.stringify(rejected));
 assert.equal(rejected.issues[0]?.code,'unknown_output_field');
});

test('reviewed generic Action supports a bounded larger input without changing legacy defaults',async()=>{
 const input={message:'中文'.repeat(4000)};
 const extended={...manifest,max_input_bytes:24576,input_schema:{...manifest.input_schema,properties:{message:{type:'string'}}}};
 const legacy={...extended}; delete (legacy as Partial<typeof extended>).max_input_bytes;
 const validate=async (contract:object,payload:unknown)=>{
   const contract_digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
     new TextEncoder().encode(JSON.stringify(canonical(contract))))),x=>x.toString(16).padStart(2,'0')).join('');
   return new WorkflowService({ACTIONS:{...provider,getContract:async()=>({manifest:contract,contract_digest,deployment_id:deployment})}} as any)
    .validateDefinition(definition(payload));
 };
 assert.equal((await validate(legacy,input)).valid,false);
 assert.equal((await validate(extended,input)).valid,true);
 assert.equal((await validate(extended,{message:'中'.repeat(8192)})).valid,false);
 for(const invalid of [0,-1,1.5,24577,'24576',null]){
   await assert.rejects(()=>validate({...extended,max_input_bytes:invalid},{message:'short'}),/cloudflare_action_catalog_untrusted/);
 }
});

test('generic discovery refuses caller-owned invocation metadata and unbounded error declarations',async()=>{
 for(const change of [
  ...['invocation_id','deployment_id','contract_digest','input_digest'].map(k=>({
   input_schema:{...manifest.input_schema,properties:{...manifest.input_schema.properties,[k]:{type:'string'}}}})),
  ...[[],['E_OK','E_OK'],['raw message'],['x'.repeat(81)],Array.from({length:33},(_,i)=>'E_'+i)].map(error_codes=>({error_codes})),
 ]){
  const changed={...manifest,...change};
  const pin=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
   new TextEncoder().encode(JSON.stringify(canonical(changed))))),x=>x.toString(16).padStart(2,'0')).join('');
  const svc=new WorkflowService({ACTIONS:{...provider,getContract:async()=>({manifest:changed,contract_digest:pin,deployment_id:deployment})}} as any);
  await assert.rejects(()=>svc.validateDefinition(definition({message:'ok'})),/cloudflare_action_catalog_untrusted/);
 }
});
test('ordinary reviewed output is allowed as generic input, undeclared protected fields are not',async()=>{
 const make=(field:string)=>JSON.stringify({version:1,name:'reference',steps:[
  {id:'source',uses:'result.emit',with:{data:{status:'accepted'}}},
  {id:'target',needs:['source'],uses:'action.run',with:{action_id:'json.report',input:{message:{ref:'steps.source.output.'+field}}}},
 ]});
 const allowed=await service.validateDefinition(make('status'));
 assert.equal(allowed.valid,true,JSON.stringify(allowed));
 for(const field of ['credential','session_url','bytes','input_digest']){
  const result=await service.validateDefinition(make(field));
  assert.equal(result.valid,false);
  assert.equal(result.issues[0]?.code,'unknown_output_field');
 }
});
