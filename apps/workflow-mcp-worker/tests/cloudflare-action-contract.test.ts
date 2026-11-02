import test from 'node:test';
import assert from 'node:assert/strict';
import {compilePlan} from '../src/plan.ts';
import {cloudflareActionManifest,hasRetiredWeixinAction,isRetiredWeixinAction} from '../src/cloudflare-action-contract.ts';

test('every historical Weixin contract and compatibility alias is retired at compile-time',async()=>{
 const manifests=[await cloudflareActionManifest('weixin'),
  await cloudflareActionManifest('generic'),await cloudflareActionManifest('unified-generic'),
  await cloudflareActionManifest('download')];
 for(const manifest of manifests){
  const step={id:'legacy',uses:'action.run',with:{executor:'cloudflare',
   provider:'weixin',action:manifest.action,contract_digest:manifest.contract_digest,
   input:{text:'test',download_step_id:'download_task'}}};
  const plan={version:1,name:'Historical',steps:[step]};
  assert.equal(hasRetiredWeixinAction(plan),true);
  await assert.rejects(compilePlan(plan),/weixin_action_retired/);
 }
 for(const [provider,action] of [['weixin','send_text'],
  ['bark','weixin.send_text'],['weixin','weixin.legacy_send']]){
  const step={id:'legacy',uses:'action.run',with:{executor:'cloudflare',provider,action,
   contract_digest:'0'.repeat(64),input:{text:'test'}}};
  assert.equal(isRetiredWeixinAction(step),true);
  await assert.rejects(compilePlan({version:1,name:'Variant',steps:[step]}),/weixin_action_retired/);
 }
});

test('non-Weixin reviewed Bark and utility catalog remains compilable',async()=>{
 for(const provider of ['bark','dub','envshare','litterbox'] as const){
  const manifest=await cloudflareActionManifest(provider);
  assert.equal(hasRetiredWeixinAction({steps:[]}),false);
  assert.equal(isRetiredWeixinAction({uses:'action.run',with:{
   executor:'cloudflare',provider:manifest.provider,action:manifest.action}}),false);
 }
 assert.equal(hasRetiredWeixinAction({steps:[{uses:'action.run',
  with:{executor:'cloudflare',provider:'weixin',action:'weixin.send_text'}}]}),true);
});
