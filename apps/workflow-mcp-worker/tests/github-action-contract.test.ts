import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGitHubAction } from '../src/github-action-contract.ts';
import {reviewedGitHubOutputSource} from '../src/github-action-discovery.ts';

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
    timeout-minutes: 360
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

test('Session enforces one job, cleanup guard =360 and user duration <=300, and bounded duration',()=>{
 for(const revised of [
   valid.replace('    timeout-minutes: 360',''),
   valid.replace('timeout-minutes: 360','timeout-minutes: 359'),
   valid.replace('timeout-minutes: 360','timeout-minutes: ${{ inputs.duration_minutes }}'),
   valid.replace('default: 10','default: 301'),
   valid.replace('default: 10','default: 0'),
   valid.replace('duration_minutes:','minutes:'),
   valid.replace('    timeout-minutes: 360','    timeout-minutes: 5'),
   valid.replace('jobs:\n  test:', 'jobs:\n  other:\n    runs-on: ubuntu-latest\n    timeout-minutes: 360\n    steps: []\n  test:'),
 ]){
  assert.notEqual(revised,valid,'negative fixture must actually change YAML');
  assert.throws(()=>parseGitHubAction(revised));
 }
 const contract=parseGitHubAction(valid);
 assert.equal(contract.inputs.duration_minutes.default,10);
});

test('declared GitHub output fields change only the reviewed business contract and remain path-bound',()=>{
 const base=parseGitHubAction(valid);
 assert.equal(base.outputKind,undefined);
 assert.equal(base.outputSchema,undefined);
 const withTailnet=parseGitHubAction(valid.replace('  WORKFLOW_ACTION_TYPE: session',
  '  WORKFLOW_ACTION_TYPE: session\n  WORKFLOW_ACTION_OUTPUT_KIND: tailnet'));
 assert.equal(withTailnet.outputKind,'tailnet');
 assert.deepEqual(Object.keys((withTailnet.outputSchema as any).properties.session.properties),
  ['recorded_state','private_hostname','github_run_id']);
 assert.equal(reviewedGitHubOutputSource('.github/workflows/ubuntu.yml',withTailnet),true);
 assert.equal(reviewedGitHubOutputSource('.github/workflows/windows.yml',withTailnet),true);
 assert.equal(reviewedGitHubOutputSource('.github/workflows/chrome.yml',withTailnet),false);
 assert.equal(reviewedGitHubOutputSource('.github/workflows/custom.yml',withTailnet),false);
 const web=parseGitHubAction(valid.replace('  WORKFLOW_ACTION_TYPE: session',
  '  WORKFLOW_ACTION_TYPE: session\n  WORKFLOW_ACTION_OUTPUT_KIND: web'));
 assert.equal(reviewedGitHubOutputSource('.github/workflows/code-server.yml',web),true);
 assert.equal(reviewedGitHubOutputSource('.github/workflows/ubuntu.yml',web),false);
 for(const kind of ['custom','none']){
  assert.throws(()=>parseGitHubAction(valid.replace('  WORKFLOW_ACTION_TYPE: session',
   '  WORKFLOW_ACTION_TYPE: session\n  WORKFLOW_ACTION_OUTPUT_KIND: '+kind)),/invalid_output_declaration/);
 }
});

test('reviewed Drop task is discoverable without opening arbitrary none-output tasks',()=>{
 const task=parseGitHubAction(valid
  .replace('  WORKFLOW_ACTION_TYPE: session',
   '  WORKFLOW_ACTION_TYPE: task\n  WORKFLOW_ACTION_OUTPUT_KIND: none')
  .replace('    timeout-minutes: 360','    timeout-minutes: 15'));
 assert.equal(task.type,'task');
 assert.equal(task.outputKind,'none');
 assert.equal(reviewedGitHubOutputSource('.github/workflows/drop.yml',task),true);
 assert.equal(reviewedGitHubOutputSource('.github/workflows/download.yml',task),true);
 assert.equal(reviewedGitHubOutputSource('.github/workflows/ubuntu.yml',task),false);
 assert.equal(reviewedGitHubOutputSource('.github/workflows/unreviewed.yml',task),false);
});

test('reviewed file capability is declared by source contract, independent of Action name',()=>{
 const fixture=`name: Arbitrary reviewed file Task
on:
  workflow_dispatch:
    inputs:
      attempt_id: {type: string, required: true}
      dispatch_id: {type: string, required: true}
      capability_id: {type: string, required: true}
      drop_part_0: {type: string, required: true}
      drop_part_1: {type: string, required: false, default: ''}
      drop_part_2: {type: string, required: false, default: ''}
env:
  WORKFLOW_ACTION_TYPE: task
  WORKFLOW_ACTION_OUTPUT_KIND: none
  WORKFLOW_ACTION_SELECTED_FILE: '{"delivery":"github_encrypted_locator_v1","extensions":[".html",".zip"],"max_bytes":10485760,"input_slots":["drop_part_0","drop_part_1","drop_part_2"],"consent":"cloudflare_terms_v1","receipt":"owner_claim_v1"}'
jobs:
  test:
    runs-on: ubuntu-latest
    steps: [{run: echo ok}]
`;
 const action=parseGitHubAction(fixture);
 assert.deepEqual(action.selectedFile,{delivery:'github_encrypted_locator_v1',
  extensions:['.html','.zip'],max_bytes:10485760,
  input_slots:['drop_part_0','drop_part_1','drop_part_2'],
  consent:'cloudflare_terms_v1',receipt:'owner_claim_v1'});
});
