import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGitHubAction } from '../src/github-action-contract.ts';

const valid = `name: Linux test
on:
  workflow_dispatch:
    inputs:
      attempt_id:
        type: string
        required: true
      dispatch_id:
        type: string
        required: true
      capability_id:
        type: string
        required: true
      duration_minutes:
        type: number
        required: false
        default: 10
      mode:
        type: choice
        options: [smoke, build]
        default: smoke
env:
  WORKFLOW_ACTION_TYPE: session
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 330
    steps:
      - run: echo hello
`;

test('parses one literal native session contract', () => {
  const parsed = parseGitHubAction(valid);
  assert.equal(parsed.type, 'session');
  assert.deepEqual(parsed.inputs.mode.options, ['smoke', 'build']);
  assert.equal(parsed.inputs.duration_minutes.default, 10);
});
test('rejects missing, unknown and dynamic type', () => {
  for (const change of ['', 'other', '${{ github.ref }}']) {
    assert.throws(() => parseGitHubAction(valid.replace('WORKFLOW_ACTION_TYPE: session', 'WORKFLOW_ACTION_TYPE: ' + change)));
  }
});
test('rejects overriding action type in a step', () => {
  assert.throws(() => parseGitHubAction(valid.replace('- run: echo hello', '- run: echo hello\n        env:\n          WORKFLOW_ACTION_TYPE: task')));
});
test('rejects undeclared extra triggers', () => {
  assert.throws(() => parseGitHubAction(valid.replace('on:\n', 'on:\n  push: {}\n')));
});
test('server identity must be declared as required string but never user input', () => {
  const parsed=parseGitHubAction(valid);
  for (const key of ['attempt_id','dispatch_id','capability_id'])
    assert.equal(Object.hasOwn(parsed.inputs,key),false);
  assert.throws(() => parseGitHubAction(valid.replace('      attempt_id:', '      missing_id:')), /missing_identity_inputs/);
  assert.throws(() => parseGitHubAction(valid.replace('      attempt_id:\n        type: string\n        required: true',
    '      attempt_id:\n        type: string\n        required: false')), /reserved_input/);
  assert.throws(() => parseGitHubAction(valid.replace('default: smoke', 'default: unknown')));
  assert.throws(() => parseGitHubAction(valid.replace('default: 10', 'default: ten')));
});
test('rejects duplicate YAML mappings', () => {
  assert.throws(() => parseGitHubAction(valid + '\nenv:\n  WORKFLOW_ACTION_TYPE: task\n'));
});

test('Session enforces one job, job-start timeout <=330, and bounded duration',()=>{
 for(const revised of [
   valid.replace('    timeout-minutes: 330',''),
   valid.replace('timeout-minutes: 330','timeout-minutes: 331'),
   valid.replace('timeout-minutes: 330','timeout-minutes: ${{ inputs.duration_minutes }}'),
   valid.replace('default: 10','default: 331'),
   valid.replace('default: 10','default: 0'),
   valid.replace('duration_minutes:','minutes:'),
   valid.replace('    timeout-minutes: 330','    timeout-minutes: 5'),
   valid.replace('jobs:\n  test:', 'jobs:\n  other:\n    runs-on: ubuntu-latest\n    timeout-minutes: 330\n    steps: []\n  test:'),
 ]){
  assert.notEqual(revised,valid,'negative fixture must actually change YAML');
  assert.throws(()=>parseGitHubAction(revised));
 }
 const contract=parseGitHubAction(valid);
 assert.equal(contract.inputs.duration_minutes.default,10);
});
