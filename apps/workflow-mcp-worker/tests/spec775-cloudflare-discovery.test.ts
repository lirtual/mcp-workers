import test from 'node:test';
import assert from 'node:assert/strict';
import {discoverCloudflareActionCatalog} from '../src/action-catalog.ts';
import {canonical} from '../src/cloudflare-action-contract.ts';
const deployment='11111111-1111-4111-8111-111111111111';
const other='22222222-2222-4222-8222-222222222222';
const report=Object.freeze({executor:'cloudflare',provider:'json',action:'json.report',version:1,
 source_repository:'lirtual/cloudflare-actions',service:'cloudflare-actions',entrypoint:'ActionsEntrypoint',
 side_effect:'none',input_schema:{type:'object',additionalProperties:false,
 required:['message'],properties:{message:{type:'string',maxLength:100}}},
 output_schema:{type:'object',additionalProperties:false,
 required:['status'],properties:{status:{enum:['accepted','rejected','unknown']}}},
});
const digest=async(v:unknown)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
 new TextEncoder().encode(JSON.stringify(canonical(v))))),b=>b.toString(16).padStart(2,'0')).join('');
const binding=(manifest:unknown,version=deployment)=>({
 listActions:async()=>[{action_id:'json.report'}],
 getContract:async(_id:string)=>({manifest,deployment_id:version,contract_digest:await digest(manifest)}),
});
test('source-reviewed Provider JSON Action discovers automatically without Consumer name list',async()=>{
 const found=await discoverCloudflareActionCatalog({ACTIONS:binding(report) as any});
 assert.equal(found.actions.length,1);
 assert.equal(found.actions[0].action_id,'json.report');
 assert.equal(found.actions[0].executor,'cloudflare');
 assert.equal(found.actions[0].contract_digest,await digest(report));
 assert.equal(found.actions[0].deployment_id,deployment);
});
test('unknown Provider, forged source, colliding ids and deployment split fail closed',async()=>{
 const bad={...report,source_repository:'attacker/actions'};
 await assert.rejects(()=>discoverCloudflareActionCatalog({ACTIONS:binding(bad) as any}));
 const duplicated={...binding(report),listActions:async()=>[
  {action_id:'json.report'},{action_id:'json.report'}]};
 await assert.rejects(()=>discoverCloudflareActionCatalog({ACTIONS:duplicated as any}));
 const split={...binding(report),listActions:async()=>[
  {action_id:'json.report'},{action_id:'json.other'}],
  getContract:async(id:string)=>({manifest:{...report,action:id},
   deployment_id:id==='json.report'?deployment:other,
   contract_digest:await digest({...report,action:id})})};
 await assert.rejects(()=>discoverCloudflareActionCatalog({ACTIONS:split as any}));
 await assert.rejects(()=>discoverCloudflareActionCatalog({ACTIONS:undefined as any}));
});
