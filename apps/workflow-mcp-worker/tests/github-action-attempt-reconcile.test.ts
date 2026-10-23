import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcilePersistedGitHubActionAttempt} from '../src/github-action-attempt-reconcile.ts';

const id='11111111-1111-4111-8111-111111111111';
function fakeDb(changed=false){
 let candidate=42;
 const statements:string[]=[];
 const db={prepare:(sql:string)=>({
  bind:(...args:unknown[])=>({
   first:async()=>{
    assert.equal(args[0],id);
    return {candidate_run_id:candidate,candidate_run_attempt:1};
   },
   run:async()=>{
    statements.push(sql);
    return {meta:{changes:1}};
   },
  }),
 })};
 return {db:db as any,statements,alter:()=>{candidate=43;}};
}
test('nonterminal physical evidence never writes state',async()=>{
 const f=fakeDb();
 assert.equal(await reconcilePersistedGitHubActionAttempt(f.db,id,'token',async()=>({state:'running'})),'held');
 assert.equal(f.statements.length,0);
});
test('candidate drift during readback never writes a terminal state',async()=>{
 const f=fakeDb();
 assert.equal(await reconcilePersistedGitHubActionAttempt(f.db,id,'token',async()=>{
  f.alter();return {state:'completed',conclusion:'success'};
 }),'conflict');
 assert.equal(f.statements.length,0);
});
test('confirmed physical terminal delegates to conditional SQL and leaves parent unchanged',async()=>{
 const f=fakeDb();
 assert.equal(await reconcilePersistedGitHubActionAttempt(f.db,id,'token',async()=>({state:'completed',conclusion:'success'})),'updated');
 assert.equal(f.statements.length,1);
 assert.match(f.statements[0],/state='claimed'/);
 assert.match(f.statements[0],/owner_run_id=\?/);
});
