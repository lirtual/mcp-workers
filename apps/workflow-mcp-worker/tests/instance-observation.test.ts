import test from 'node:test';
import assert from 'node:assert/strict';
import { observeInstance, shouldExpireUnconfirmedOutcome } from '../src/instance-observation.ts';

test('existing Workflow instance observation confirms its actual state', async () => {
 const observed=await observeInstance({get:async()=>({status:async()=>({status:'running'})})},'run-id');
 assert.deepEqual(observed,{kind:'found',status:'running'});
});
test('only explicit not-found permits same-id creation; transient errors do not', async () => {
 const unavailable=await observeInstance({get:async()=>{throw Error('Cloudflare service unavailable')}},'run-id');
 assert.deepEqual(unavailable,{kind:'unavailable'});
 const timedOut=await observeInstance({get:async()=>({status:async()=>{throw Error('network timeout')}})},'run-id');
 assert.deepEqual(timedOut,{kind:'unavailable'});
 const missing=await observeInstance({get:async()=>{throw Error('instance.not_found')}},'run-id');
 assert.deepEqual(missing,{kind:'missing'});
 const edgeMissing=await observeInstance({get:async()=>{throw Error('(instance.not_found) Instance not found')}},'run-id');
 assert.deepEqual(edgeMissing,{kind:'missing'});
 const unknown=await observeInstance({get:async()=>{throw Error('unexpected instance not found for an unrelated request')}},'run-id');
 assert.deepEqual(unknown,{kind:'unavailable'});
});
test('stalled native complete is only expired after a bounded settling window', () => {
 const now=1_000_000,window=10*60_000;
 assert.equal(shouldExpireUnconfirmedOutcome('complete','queued',now-window+100,now),false);
 assert.equal(shouldExpireUnconfirmedOutcome('complete','running',now-window-1,now),true);
 assert.equal(shouldExpireUnconfirmedOutcome('running','running',now-window-1,now),false);
 assert.equal(shouldExpireUnconfirmedOutcome('unknown','queued',now-window-1,now),false);
 assert.equal(shouldExpireUnconfirmedOutcome('complete','succeeded',now-window-1,now),false);
});
