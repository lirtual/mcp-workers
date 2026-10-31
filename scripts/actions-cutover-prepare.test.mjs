import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {verifyPausedInventory,verifyLegacyActionsBindings,verifyFrozenGate,
 readOnlyPrepare} from './actions-cutover-prepare.mjs';
const old=[
 {type:'service',name:'WEIXIN_ACTION_PROVIDER',service:'weixin-mcp-worker',entrypoint:'WeixinActionProvider'},
 {type:'service',name:'BARK_ACTION_PROVIDER',service:'bark-provider',entrypoint:'BarkActionProvider'}
];
const good={active_workflows:0,paused_workflows:6,unsettled_runs:0};
test('cutover preparation requires fully paused published admissions and terminal Runs',()=>{
 assert.equal(verifyPausedInventory([good]),true);
 for(const bad of [{...good,active_workflows:1},{...good,paused_workflows:0},
  {...good,unsettled_runs:1},{...good,active_workflows:null},{}])
  assert.throws(()=>verifyPausedInventory([bad]),/blocked/);
 assert.throws(()=>verifyPausedInventory([]),/blocked/);
});
test('migration-only mode refuses changed legacy service targets or unified binding',()=>{
 assert.equal(verifyLegacyActionsBindings(old),true);
 assert.throws(()=>verifyLegacyActionsBindings([]),/blocked/);
 assert.throws(()=>verifyLegacyActionsBindings([...old,{type:'service',name:'ACTIONS'}]),/blocked/);
 assert.throws(()=>verifyLegacyActionsBindings([{...old[0],service:'changed'},old[1]]),/blocked/);
});
test('fence must read exact new migration and frozen state',()=>{
 assert.equal(verifyFrozenGate([{gate_state:'frozen',migration_count:1}]),true);
 for(const bad of [[{gate_state:'open',migration_count:1}],
  [{gate_state:'frozen',migration_count:0}],[],null])
  assert.throws(()=>verifyFrozenGate(bad),/blocked/);
});
test('read-only preflight checks legacy bindings, D1 paused inventory and six native statuses',async()=>{
 const calls=[];
 const fake=async(url,options)=>{
  const u=new URL(url);calls.push({path:u.pathname,method:options.method,body:options.body});
  const data=u.pathname.endsWith('/settings')?{success:true,result:{bindings:old}}:
   u.pathname.endsWith('/query')?{success:true,result:[{success:true,results:[good]}]}:
   {success:true,result:[],result_info:{count:0,total_count:0}};
  return {ok:true,json:async()=>data};
 };
 const env={CLOUDFLARE_ACCOUNT_ID:'f'.repeat(32),CLOUDFLARE_API_TOKEN:'test',ACTIONS_OLD_INGRESS_QUIESCED:'true'};
 assert.equal(await readOnlyPrepare(env,fake),true);
 assert.equal(calls.length,8);
 assert.deepEqual(calls.map(c=>c.method),['GET','POST',...Array(6).fill(undefined)]);
 assert.match(JSON.parse(calls[1].body).sql,/SELECT .*COUNT\(\*\)/);
 assert.ok(calls.every(c=>!c.body||/^SELECT\s/i.test(JSON.parse(c.body).sql.trim())));
 await assert.rejects(()=>readOnlyPrepare({...env,ACTIONS_OLD_INGRESS_QUIESCED:'false'},fake),/quiescence/);
 assert.equal(calls.length,8);
});
test('prepare mode uses the current main, existing Workflow release environment and cannot deploy',()=>{
 const s=readFileSync(new URL('../.github/workflows/release.yml',import.meta.url),'utf8');
 const idx=s.indexOf('  workflow-actions-migration-prepare:');
 const end=s.indexOf('  checks:',idx);
 assert.ok(idx>0&&end>idx);
 const job=s.slice(idx,end);
 for(const required of ["github.actor == 'lirtual'", "inputs.deploy_to_production == false",
  "inputs.actions_migration_prepare == true", "inputs.actions_old_ingress_quiesced == true",
  'name: workflow-mcp-worker','group: worker-release-workflow-mcp-worker',
  'actions-cutover-prepare.mjs preflight','wrangler d1 migrations apply workflow-mcp-db --remote',
  "state='frozen'",'actions-cutover-prepare.mjs postflight'])
  assert.ok(job.includes(required),required);
 assert.ok(job.indexOf('mjs preflight')<job.indexOf('d1 migrations apply'));
 assert.ok(job.indexOf('d1 migrations apply')<job.indexOf('mjs postflight'));
 assert.ok(!job.includes('wrangler deploy')&&!job.includes('deploy_to_production == true'));
 assert.ok(s.includes("needs.checks.outputs.release_ready == 'true' && inputs.actions_migration_prepare != true"));
});
