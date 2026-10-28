import test from 'node:test';
import assert from 'node:assert/strict';
import {compilePlan} from '../src/plan.ts';
import {cloudflareActionManifest} from '../src/cloudflare-action-contract.ts';
const github={repository:'lirtual/session-actions',repositoryId:1,workflowId:2,
 workflowPath:'.github/workflows/openlist.yml',commitSha:'a'.repeat(40),
 type:'session',contractDigest:'b'.repeat(64),ref:'refs/tags/v1',inputs:{duration_minutes:5}};
const source={version:1,name:'OpenList to Owner Weixin',steps:[
 {id:'openlist',uses:'github.run',with:{capability:'github.action',action:github}},
 {id:'notify',needs:['openlist'],uses:'action.run',with:{executor:'cloudflare',
  provider:'weixin',action:'weixin.send_text',contract_digest:'0'.repeat(64),
  input:{session_step_id:'openlist'}}},
]};
test('Cloudflare source must pin reviewed contract and the same-Run OpenList session',async()=>{
 const manifest=await cloudflareActionManifest();
 const plan: any=structuredClone(source);
 plan.steps[1]!.with.contract_digest=manifest.contract_digest;
 const result=await compilePlan(plan);
 assert.equal(result.plan.steps[1]!.uses,'action.run');
 assert.deepEqual(result.plan.steps[1]!.needs,['openlist']);
 for(const mutation of [
  (p:any)=>{p.steps[1]!.with.contract_digest='0'.repeat(64);},
  (p:any)=>{p.steps[1]!.with.input.session_step_id='arbitrary';},
  (p:any)=>{p.steps[1]!.with.provider='attacker';},
  (p:any)=>{p.steps[1]!.with.endpoint='https://attacker.example';},
  (p:any)=>{p.steps[0]!.with.action.workflowPath='.github/workflows/chrome.yml';},
  (p:any)=>{p.steps[1]!.needs=[];},
 ]){const changed: any=structuredClone(plan);mutation(changed);await assert.rejects(compilePlan(changed));}
});

test('one OpenList Session cannot unexpectedly trigger duplicate Cloudflare notification steps',async()=>{
 const m=await cloudflareActionManifest();
 const plan:any=structuredClone(source);
 plan.steps[1].with.contract_digest=m.contract_digest;
 plan.steps.push({...structuredClone(plan.steps[1]),id:'notify_again'});
 await assert.rejects(compilePlan(plan),/multiple_cloudflare_actions_unsupported/);
});
