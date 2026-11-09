import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
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
test('a new reviewed side effect needs no Consumer action name',async()=>{
 const source=readFileSync(new URL('../src/action-catalog.ts',import.meta.url),'utf8');
 assert.equal(source.includes('json.mark'),false);
 assert.equal(source.includes('record_audited_marker'),false);
 const marked={...report,action:'json.mark',side_effect:'record_audited_marker'};
 const found=await discoverCloudflareActionCatalog({ACTIONS:{
  listActions:async()=>[{action_id:'json.mark'}],
  getContract:async()=>({manifest:marked,deployment_id:deployment,contract_digest:await digest(marked)}),
 } as any});
 assert.equal(found.actions[0].action_id,'json.mark');
 assert.equal(found.actions[0].manifest.side_effect,'record_audited_marker');
 const borrowed={...marked,side_effect:'send_to_configured_owner_only'};
 await assert.rejects(()=>discoverCloudflareActionCatalog({ACTIONS:{
  listActions:async()=>[{action_id:'json.mark'}],
  getContract:async()=>({manifest:borrowed,deployment_id:deployment,contract_digest:await digest(borrowed)}),
 } as any}));
 const relabeled={...report,action:'bark.send_notification',provider:'bark',side_effect:'none'};
 await assert.rejects(()=>discoverCloudflareActionCatalog({ACTIONS:{
  listActions:async()=>[{action_id:'bark.send_notification'}],
  getContract:async()=>({manifest:relabeled,deployment_id:deployment,contract_digest:await digest(relabeled)}),
 } as any}));
});
