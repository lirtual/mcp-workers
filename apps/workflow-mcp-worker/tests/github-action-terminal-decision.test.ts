import test from 'node:test';
import assert from 'node:assert/strict';
import { decidePhysicalGitHubTerminal } from '../src/github-action-terminal-decision.ts';

test('only authenticated physical terminal evidence can settle',()=>{
 assert.deepEqual(decidePhysicalGitHubTerminal({state:'completed',conclusion:'success'}),
  {kind:'terminal',outcome:'succeeded',conclusion:'success'});
 assert.deepEqual(decidePhysicalGitHubTerminal({state:'completed',conclusion:'cancelled'}),
  {kind:'terminal',outcome:'cancelled',conclusion:'cancelled'});
 assert.deepEqual(decidePhysicalGitHubTerminal({state:'completed',conclusion:'timed_out'}),
  {kind:'terminal',outcome:'failed',conclusion:'timed_out'});
});
test('queued, running, unknown or identity mismatch cannot settle',()=>{
 for(const state of [{state:'queued'},{state:'running'},{state:'unknown'},{state:'identity_mismatch'}] as const)
  assert.equal(decidePhysicalGitHubTerminal(state).kind,'hold');
});
test('ambiguous GitHub conclusions must not be treated as successful business result',()=>{
 for(const conclusion of ['neutral','skipped','action_required','stale'] as const)
  assert.deepEqual(decidePhysicalGitHubTerminal({state:'completed',conclusion}),
    {kind:'hold',reason:'ambiguous_conclusion'});
});
