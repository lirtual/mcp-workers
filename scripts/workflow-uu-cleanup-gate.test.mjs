import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {verifyUuCleanupGuard,verifyUuNativeQuiet,uuReadinessSql} from './workflow-uu-cleanup-gate.mjs';
import {verifyWorkflowMigrationReadiness} from './manual-worker-release.mjs';
const sha='a'.repeat(40);
const version='3f27e9ca-790c-4ec9-914e-cb4204a736e6';
const bindings=[
 {name:'ACTIONS',type:'service'},
 {name:'DB',type:'d1',id:'a4a477cd-6339-478c-ab7c-f7d87bb0d772'},
 {name:'WORKFLOW',type:'workflow'},
 {name:'MCP_ACCESS_TOKEN',type:'secret_text'},
 {name:'WORKFLOW_GITHUB_DISPATCH_TOKEN',type:'secret_text'},
 {name:'WORKFLOW_MCP_PORTAL_CLIENT_SECRET',type:'secret_text'},
 {name:'WORKFLOW_GITHUB_ACTION_APPROVED_REPOSITORIES',type:'plain_text'},
 {name:'WORKFLOW_GITHUB_ACTION_OIDC_AUDIENCE',type:'plain_text'},
 {name:'WORKFLOW_MCP_PORTAL_CLIENT_ID',type:'plain_text'},
 {name:'WORKFLOW_MCP_PORTAL_ENDPOINT',type:'plain_text'}
];
const before={migration_count:20,migration_v10:1,migration_v20:1,migration_v21:0,reviewed_migrations:20,
 table_present:1,table_rows:0,unknown_runs:12,reviewed_unknown_runs:12,unreviewed_runs:0,active_runs:0,
 unresolved_steps:12,indeterminate_steps:11,reviewed_ima_running:1,unreviewed_steps:0,unresolved_attempts:1,reviewed_claimed_attempt:1,unreviewed_attempts:0,
 active_sessions:0,pending_windows_attempts:0,undelivered_callbacks:0,
 windows_state:'paused',old_rca_retired:1,old_rca_version:1,action_gate:'open',
 run_proof:Array(12).fill('run').join('|'),step_proof:Array(12).fill('step').join('|'),attempt_proof:'reviewed-claimed-state'};
const fixture=(stage='before')=>({
 stage,expectedSha:sha,sourceSha:sha,expectedVersion:version,
 live:{deployments:[{versions:[{version_id:version,percentage:100}]}]},
 version:{id:version,number:143,resources:{bindings:structuredClone(bindings)}},
 row:stage==='after'?{...before,migration_count:21,migration_v21:1,table_present:0}:{...before},
 previous:stage==='after'?{run_proof:before.run_proof,step_proof:before.step_proof,attempt_proof:before.attempt_proof}:undefined,
});
test('spec774 isolated empty table gate accepts exact Version143 + preserved 12/12/1',()=>{
 assert.equal(verifyUuCleanupGuard(fixture()).run_proof.split('|').length,12);
 assert.equal(verifyUuCleanupGuard(fixture('after')).attempt_proof,'reviewed-claimed-state');
});
test('unsafe schema, active writers, plan admission and historical drift all fail closed',()=>{
 for(const [name,value] of Object.entries({
  table_rows:1,table_present:0,migration_count:21,migration_v21:1,reviewed_migrations:19,reviewed_unknown_runs:11,indeterminate_steps:10,reviewed_ima_running:0,reviewed_claimed_attempt:0,
  unknown_runs:11,unreviewed_runs:1,active_runs:1,unresolved_steps:11,
  unreviewed_steps:1,unresolved_attempts:0,unreviewed_attempts:1,
  active_sessions:1,pending_windows_attempts:1,undelivered_callbacks:1,
  windows_state:'active',old_rca_retired:0,old_rca_version:0,action_gate:'frozen'})){
  const x=fixture();x.row[name]=value;
  assert.throws(()=>verifyUuCleanupGuard(x),/UU DROP gate/,name);
 }
 const x=fixture('after');x.row.run_proof='modified|'+x.row.run_proof.split('|').slice(1).join('|');
 assert.throws(()=>verifyUuCleanupGuard(x),/historical data drift/);
});
test('only exact 100% Version143 with all ten retained bindings is eligible',()=>{
 const c=fixture();c.live.deployments[0].versions[0].percentage=99;
 assert.throws(()=>verifyUuCleanupGuard(c),/100% active/);
 const p=fixture();p.version.number=142;assert.throws(()=>verifyUuCleanupGuard(p),/Version143/);
 const s=fixture();s.version.resources.bindings.push({name:'WORKFLOW_SESSION_RUNTIME_DATA_KEY',type:'secret_text'});
 assert.throws(()=>verifyUuCleanupGuard(s),/ten bindings/);
 const d=fixture();d.version.resources.bindings.find(b=>b.name==='DB').id='other';
 assert.throws(()=>verifyUuCleanupGuard(d),/D1 binding/);
 const e=fixture();e.expectedSha='b'.repeat(40);assert.throws(()=>verifyUuCleanupGuard(e),/main SHA/);
});
test('read-only SQL targets exact historical IDs and never queries retired table after DROP',()=>{
 const initial=uuReadinessSql('before'),after=uuReadinessSql('after');
 assert.match(initial,/FROM session_runtime_data/);
 assert.doesNotMatch(after,/FROM session_runtime_data/);
 for(const text of [initial,after]){
  assert.match(text,/unreviewed_runs/);
  assert.match(text,/unreviewed_steps/);
  assert.match(text,/unreviewed_attempts/);
  assert.match(text,/f99bb918-2909-46df-b196-d07faa64df27/);
  assert.doesNotMatch(text,/\b(?:UPDATE|INSERT|DELETE|DROP)\s+(?:FROM|TABLE|INTO)\b/i);
 }
});
test('generic migration still strictly rejects 12 old indeterminate Runs',()=>{
 const old={migration_count:20,expected_migrations:20,workflow_count:46,run_count:208,
  session_count:8,attempt_count:182,callback_count:7,cancellation_count:0,
  nonterminal_runs:12,unresolved_starts:0,unresolved_steps:12,
  invalid_cancelled_steps:0,nonterminal_attempts:1,nonterminated_sessions:0,
  undelivered_callbacks:0};
 assert.throws(()=>verifyWorkflowMigrationReadiness([{success:true,results:[old]}]),
   /Workflow migration blocked by nonterminal_runs/);
});
test('native Workflow zero and pagination completeness are both mandatory',()=>{
 const zero={result:[],result_info:{count:0,total_count:0,per_page:100}};
 for(const state of ['queued','running','paused','waiting','waitingForPause','rollingBack'])
  assert.doesNotThrow(()=>verifyUuNativeQuiet(zero,state));
 for(const bad of [
  {result:[{}],result_info:{count:1,total_count:1,per_page:100}},
  {result:[],result_info:{count:0,total_count:0,per_page:99}},
  {result:[],result_info:{count:0,total_count:0,per_page:100,cursor:'x'}},
  {result:[],result_info:{count:0,total_count:1,per_page:100}},
 ])assert.throws(()=>verifyUuNativeQuiet(bad,'running'),/UU DROP gate/);
});
test('0021 is one-table destructive migration and does not change historical data',async()=>{
 const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(':memory:');
 db.exec("CREATE TABLE session_runtime_data(run_id TEXT); CREATE TABLE runs(id TEXT,outcome TEXT); INSERT INTO runs VALUES('keep','indeterminate')");
 const sql=readFileSync(new URL('../apps/workflow-mcp-worker/migrations/0021_retire_uu_session_data.sql',import.meta.url),'utf8');
 assert.match(sql,/DROP TABLE session_runtime_data;/);
 assert.equal((sql.match(/^DROP TABLE /gm)||[]).length,1);
 db.exec(sql);
 assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='session_runtime_data'").get().n,0);
 assert.deepEqual(db.prepare('SELECT * FROM runs').all().map(x=>({...x})),[{id:'keep',outcome:'indeterminate'}]);
 db.close();
});
test('only isolated release job can apply 0021, and secret cleanup remains separate',()=>{
 const release=readFileSync(new URL('../.github/workflows/release.yml',import.meta.url),'utf8');
 const special=release.split('  workflow-uu-table-retirement:')[1]?.split('  legacy-secret-cleanup:')[0];
 assert.ok(special);
 for(const clause of ["github.actor == 'lirtual'","inputs.uu_cleanup_approved == true",
   'inputs.deploy_to_production == false',"inputs.legacy_secret_cleanup_mode == 'none'",
   "needs.checks.result == 'success'","needs.checks.outputs.release_ready == 'true'",
   'worker-release-workflow-mcp-worker','workflow-uu-cleanup-gate.mjs before',
   'workflow-uu-cleanup-gate.mjs after','d1 migrations apply workflow-mcp-db --remote'])
  assert.ok(special.includes(clause),clause);
 assert.doesNotMatch(special,/wrangler deploy|wrangler versions deploy|secret delete|gh secret delete/);
 assert.match(release,/Prevent normal Workflow release from applying pending UU DROP/);
 assert.match(release,/Block legacy Actions migration preparation with staged destructive 0021/);
 assert.match(release,/inputs.uu_cleanup_approved != true/);
});
