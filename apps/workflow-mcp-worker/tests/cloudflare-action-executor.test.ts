import test from 'node:test';
import assert from 'node:assert/strict';
import {runPublishedCloudflareAction} from '../src/cloudflare-action-executor.ts';
import {cloudflareActionManifest} from '../src/cloudflare-action-contract.ts';
import type {Plan,Step} from '../src/plan.ts';
import type {Env} from '../src/store.ts';

test('all historical Weixin spellings fail before reading credentials, receipts or reserving RPC',async()=>{
 let requests=0;
 const env={DB:{prepare(){requests++;throw Error('no_d1_allowed');}},
  ACTIONS:{getContract(){requests++;throw Error('no_provider_allowed');},
    execute(){requests++;throw Error('no_send_allowed');},
    getReceipt(){requests++;throw Error('no_receipt_allowed');}}} as unknown as Env;
 for(const [provider,action] of [
  ['weixin','weixin.send_text'],['weixin','weixin.notify_download'],
  ['weixin','send_text'],['weixin','weixin.legacy_send'],
  ['bark','weixin.send_text'],
 ]){
  const step={id:'notify',uses:'action.run',needs:[],with:{
   executor:'cloudflare',provider,action,contract_digest:'a'.repeat(64),input:{text:'historical'}}} as Step;
  const plan={version:1,name:'Historical',steps:[step],
   cloudflare_execution_approved:true,cloudflare_action_approvals:[{
    executor:'cloudflare',provider,action,contract_digest:'a'.repeat(64),
    deployment_id:'11111111-1111-4111-8111-111111111111'}]} as Plan;
  const result=await runPublishedCloudflareAction(env,plan,step,
   '22222222-2222-4222-8222-222222222222');
  assert.deepEqual(result,{status:'failed',error_code:'weixin_action_retired'});
 }
 assert.equal(requests,0,'legacy grant or historical receipt must never cause send');
});

test('non-reviewed Cloudflare Action variants fail without Provider RPC',async()=>{
 let rpc=0;
 const env={ACTIONS:{execute(){rpc++;throw Error('unexpected');}}} as unknown as Env;
 const step={id:'x',uses:'action.run',needs:[],with:{executor:'cloudflare',
  provider:'bark',action:'bark.old_notify',input:{notification:{body:'hi'}}}} as Step;
 const plan={version:1,name:'No fallback',steps:[step]} as Plan;
 assert.deepEqual(await runPublishedCloudflareAction(env,plan,step,'run'),
  {status:'failed',error_code:'cloudflare_action_not_reviewed'});
 assert.equal(rpc,0);
 const bark=await cloudflareActionManifest('bark');
 assert.equal(bark.action,'bark.send_notification');
});
