import test from 'node:test';
import assert from 'node:assert/strict';
import { validateGitHubActionInputs,resolveSessionActionInputs,isSessionDurationInputRef } from '../src/github-action-inputs.ts';
import type { DiscoveredAction } from '../src/github-action-contract.ts';

const session: DiscoveredAction = {
  name: 'Linux',
  type: 'session',
  inputs: {
    duration_minutes: { type: 'number', required: false, default: 10 },
    mode: { type: 'choice', required: true, options: ['test', 'build'] },
    verbose: { type: 'boolean', required: false, default: false },
  },
};
test('native inputs apply defaults and preserve types in dispatch string representation', () => {
  assert.deepEqual({...validateGitHubActionInputs(session, { mode: 'test' })},
    {duration_minutes: '10', mode: 'test', verbose: 'false'});
});
test('rejects caller overriding identity or undeclared keys', () => {
  for (const key of ['attempt_id', 'dispatch_id', 'capability_id', 'WORKFLOW_X', 'command', '__proto__']) {
    const input = Object.fromEntries([[key, 'forged'], ['mode', 'test']]);
    assert.throws(() => validateGitHubActionInputs(session, input), /unknown_input/);
  }
});
test('required, typed and choice values fail closed', () => {
  assert.throws(() => validateGitHubActionInputs(session, {}), /required_input/);
  assert.throws(() => validateGitHubActionInputs(session, {mode: 'test', verbose: 'false'}), /wrong_type/);
  assert.throws(() => validateGitHubActionInputs(session, {mode: 'other'}), /invalid_choice/);
});
test('session duration must be an integral number within 1 to 300', () => {
  for (const duration_minutes of [0, -1, 301, 1.5, NaN, Infinity, '10']) {
    assert.throws(() => validateGitHubActionInputs(session, {mode:'test',duration_minutes}));
  }
  assert.equal(validateGitHubActionInputs(session, {mode:'build',duration_minutes:300}).duration_minutes, '300');
});
test('large values are rejected before dispatch', () => {
  assert.throws(() => validateGitHubActionInputs({name:'Task',type:'task',inputs:{note:{type:'string',required:false}}},
    {note:'x'.repeat(4097)}), /too_large/);
});

test('only opt-in Session duration binds a numeric Run input, defaulting to 300',()=>{
 const pinned={duration_minutes:{ref:'inputs.duration_minutes'},duration_mode:'explicit',
   session_mode:'temporary'};
 const defaults={duration_minutes:300};
 assert.equal(isSessionDurationInputRef(pinned.duration_minutes),true);
 assert.equal(isSessionDurationInputRef({ref:'inputs.duration_minutes',other:true}),false);
 assert.deepEqual(resolveSessionActionInputs(pinned,defaults,{}),{
   duration_minutes:'300',duration_mode:'explicit',session_mode:'temporary'});
 assert.equal(resolveSessionActionInputs(pinned,defaults,{duration_minutes:1}).duration_minutes,'1');
 assert.equal(resolveSessionActionInputs(pinned,defaults,{duration_minutes:300}).duration_minutes,'300');
 for(const duration_minutes of [0,301,-1,1.2,'10',NaN,Infinity,null]){
   assert.throws(()=>resolveSessionActionInputs(pinned,defaults,{duration_minutes}),
     /invalid_duration/);
 }
 assert.throws(()=>resolveSessionActionInputs(pinned,{duration_minutes:10},{}),
   /binding_invalid/);
 assert.throws(()=>resolveSessionActionInputs({...pinned,duration_mode:'repository'},defaults,{}),
   /binding_invalid/);
 assert.throws(()=>resolveSessionActionInputs({...pinned,duration_minutes:{ref:'inputs.command'}},defaults,{}),
   /invalid_publication/);
});
