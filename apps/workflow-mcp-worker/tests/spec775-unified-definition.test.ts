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
