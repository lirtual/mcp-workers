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
  input:{text:'OpenList Session Ready\n',session_step_id:'openlist'}}},
]};
test('Cloudflare source must pin reviewed contract and the same-Run OpenList session',async()=>{
 const manifest=await cloudflareActionManifest('unified-generic');
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
 const m=await cloudflareActionManifest('unified-generic');
 const plan:any=structuredClone(source);
 plan.steps[1].with.contract_digest=m.contract_digest;
 plan.steps.push({...structuredClone(plan.steps[1]),id:'notify_again'});
 await assert.rejects(compilePlan(plan),/multiple_cloudflare_actions_unsupported/);
});

test('download notification requires a reviewed one-item download Task foreach',async()=>{
 const manifest=await cloudflareActionManifest('download');
 const githubTask={...github,type:'task',workflowPath:'.github/workflows/download.yml',
  inputs:{batch_json:{ref:'item.value'}}};
 const source:any={version:1,name:'download notification',inputs:{download_batches:['']},steps:[
  {id:'download_task',flow:'foreach',items:{ref:'inputs.download_batches'},max_items:1,
   template:{steps:[{id:'submit_download',uses:'action.run',with:{executor:'github',capability:'github.action',action:githubTask}}]}},
  {id:'notify',needs:['download_task'],uses:'action.run',
   with:{executor:'cloudflare',provider:'weixin',action:'weixin.notify_download',
    contract_digest:manifest.contract_digest,input:{download_step_id:'download_task'}}}
 ]};
 // Exact dynamic GitHub Task input is validated by the reviewed Action catalog.
 // Local compiler's pinned source retains the authored step's reviewed shape.
 const valid=await compilePlan(source);
 assert.equal(valid.plan.steps[1]?.with.action,'weixin.notify_download');
 for(const mutation of [
  (p:any)=>{p.steps[0].max_items=2;},
  (p:any)=>{p.steps[0].template.steps[0].with.action.workflowPath='.github/workflows/openlist.yml';},
  (p:any)=>{p.steps[1].needs=[];},
  (p:any)=>{p.steps[1].with.input.download_step_id='unknown';},
  (p:any)=>{p.steps[1].with.input.body='attacker';},
  (p:any)=>{p.steps[1].with.contract_digest='0'.repeat(64);}
 ]){
  const altered=structuredClone(source);mutation(altered);
  await assert.rejects(compilePlan(altered));
 }
});

test('generic Owner text can follow any verified prerequisite without a new action contract',async()=>{
 const manifest=await cloudflareActionManifest('unified-generic');
 const p:any={version:1,name:'Download finished',steps:[
  {id:'done',uses:'result.emit',with:{data:'verified'}},
  {id:'notify',needs:['done'],uses:'action.run',with:{executor:'cloudflare',
   provider:'weixin',action:'weixin.send_text',contract_digest:manifest.contract_digest,
   input:{text:'Koofr 下载完成，云端文件回读校验已通过。'}}}
 ]};
 assert.equal((await compilePlan(p)).plan.steps[1]?.with.action,'weixin.send_text');
 for(const bad of ['', '  ', 'a'.repeat(2049)]){
  const altered=structuredClone(p);altered.steps[1].with.input.text=bad;
  await assert.rejects(compilePlan(altered),/invalid_weixin_text/);
 }
 for(const change of [(x:any)=>{x.steps[1].with.input.recipient='attacker';},
  (x:any)=>{x.steps[1].with.input.text={ref:'steps.done.output'};},
  (x:any)=>{x.steps[1].with.contract_digest='0'.repeat(64);}]){
  const altered=structuredClone(p);change(altered);
  await assert.rejects(compilePlan(altered));
 }
});

test('existing verified download Task can notify through generic text without a download-specific Action',async()=>{
 const old=await cloudflareActionManifest('download');
 const generic=await cloudflareActionManifest('unified-generic');
 const task={...github,type:'task',workflowPath:'.github/workflows/download.yml',
  inputs:{batch_json:{ref:'item.value'}}};
 const p:any={version:1,name:'generic download',inputs:{download_batches:['']},steps:[
  {id:'download_task',flow:'foreach',items:{ref:'inputs.download_batches'},max_items:1,
   template:{steps:[{id:'submit_download',uses:'action.run',with:{executor:'github',capability:'github.action',action:task}}]}},
  {id:'notify',needs:['download_task'],uses:'action.run',with:{executor:'cloudflare',
   provider:'weixin',action:'weixin.send_text',contract_digest:generic.contract_digest,
   input:{text:'Koofr 下载完成，云端文件回读校验已通过。'}}}
 ]};
 assert.notEqual(generic.contract_digest,old.contract_digest);
 assert.equal((await compilePlan(p)).plan.steps[1]?.with.action,'weixin.send_text');
});
