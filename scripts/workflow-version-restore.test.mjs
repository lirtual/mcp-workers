import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {verifyRestoreRequest,verifyRestoreVersions,verifyRestoreD1,verifyRestoreNative,restoreReadinessSql} from './workflow-version-restore.mjs';

const baseline='3f27e9ca-790c-4ec9-914e-cb4204a736e6';
const candidate='11111111-2222-4333-8444-555555555555';
const sourceSha='a'.repeat(40);
const request={worker:'workflow-mcp-worker',mode:'restore',codeOnly:'true',uuCleanup:'false',sourceSha,expectedSha:sourceSha,activeVersion:candidate,targetVersion:baseline};
const bindings=[
  {name:'ACTIONS',type:'service',service:'cloudflare-actions',entrypoint:'ActionsEntrypoint'},
  {name:'DB',type:'d1',id:'a4a477cd-6339-478c-ab7c-f7d87bb0d772'},
  {name:'WORKFLOW',type:'workflow',workflow_name:'workflow-mcp-orchestrator',class_name:'WorkflowOrchestrator'},
  {name:'MCP_ACCESS_TOKEN',type:'secret_text'},
  {name:'WORKFLOW_GITHUB_DISPATCH_TOKEN',type:'secret_text'},
  {name:'WORKFLOW_MCP_PORTAL_CLIENT_SECRET',type:'secret_text'},
  {name:'WORKFLOW_GITHUB_ACTION_APPROVED_REPOSITORIES',type:'plain_text',text:'[]'},
  {name:'WORKFLOW_GITHUB_ACTION_OIDC_AUDIENCE',type:'plain_text',text:'aud'},
  {name:'WORKFLOW_MCP_PORTAL_CLIENT_ID',type:'plain_text',text:'cid'},
  {name:'WORKFLOW_MCP_PORTAL_ENDPOINT',type:'plain_text',text:'https://mcp.lirtual.dpdns.org/mcp'},
];
const target=()=>({id:baseline,number:143,resources:{script:{etag:'old'},script_runtime:{compatibility_date:'2026-09-10'},bindings:structuredClone(bindings)}});
const current=()=>({id:candidate,number:144,resources:{script:{etag:'new'},script_runtime:{compatibility_date:'2026-09-10'},bindings:structuredClone(bindings)}});
const inv=()=>bindings.filter(x=>x.type==='secret_text').map(x=>({name:x.name}));
const deployment=(version)=>({deployments:[{versions:[{version_id:version,percentage:100}]}]});
const versions=(after=false)=>({current:current(),target:target(),deployment:deployment(after?baseline:candidate),settings:{bindings:structuredClone(bindings)},secrets:inv(),after});
const d1={migration_count:21,migration_v21:1,old_table:0,unresolved_runs:0,unknown_runs:12,active_sessions:0,openlist_state:'paused',openlist_version:'88071284-b7f3-4553-afe4-1ed3fc47972e',original_plan:1,unchanged_other_plans:5,active_count:5,paused_count:8};

test('Version 143 recovery requires exact Owner SHA, Worker, flags and target',()=>{
  assert.equal(verifyRestoreRequest(request),true);
  for(const change of [
    {worker:'ssh-mcp-worker'},{mode:'publish'},{mode:'none'},{codeOnly:'false'},{uuCleanup:'true'},
    {sourceSha:'b'.repeat(40)},{expectedSha:'b'.repeat(40)},{expectedSha:'invalid'},
    {activeVersion:baseline},{activeVersion:'bad'},{targetVersion:candidate},{targetVersion:'bad'},
  ])assert.throws(()=>verifyRestoreRequest({...request,...change}),/restore blocked/i);
});
test('Version 143 and current version must be unique 100% and retain exact 10 bindings',()=>{
  assert.equal(verifyRestoreVersions(versions()),true);
  assert.equal(verifyRestoreVersions(versions(true)),true);
  for(const edit of [
    d=>d.current.id=baseline,
    d=>d.current.number=143,
    d=>d.target.number=142,
    d=>d.target.id=candidate,
    d=>d.current.resources.script_runtime.compatibility_date='2027-01-01',
    d=>d.current.resources.bindings.find(x=>x.name==='ACTIONS').service='unexpected',
    d=>d.target.resources.bindings.find(x=>x.name==='DB').id='wrong',
    d=>d.current.resources.bindings.push({name:'UNAPPROVED',type:'secret_text'}),
    d=>d.current.resources.bindings.pop(),
    d=>d.settings.bindings.pop(),
    d=>d.secrets.pop(),
    d=>d.deployment.deployments[0].versions[0].percentage=99,
    d=>d.deployment.deployments.push(d.deployment.deployments[0]),
  ]){const d=versions();edit(d);assert.throws(()=>verifyRestoreVersions(d),/restore blocked/i);}
  const bad=versions(true);bad.deployment=deployment(candidate);
  assert.throws(()=>verifyRestoreVersions(bad),/restore blocked/i);
});
test('Rollback blocks incompatible active openlist Plan and altered historical D1',()=>{
  assert.equal(verifyRestoreD1(d1),true);
  for(const [name,v] of Object.entries(d1)){
    const altered={...d1,[name]:typeof v==='string'?'different':v===0?1:0};
    assert.throws(()=>verifyRestoreD1(altered),/restore blocked/i,name);
  }
  assert.throws(()=>verifyRestoreD1({...d1,openlist_state:'active'}),/restore blocked/i);
  // 新版本发布了任一业务 Plan、启用了历史 Workflow 时都禁止旧代码回退。
  assert.throws(()=>verifyRestoreD1({...d1,unchanged_other_plans:4}),/restore blocked/i);
  assert.throws(()=>verifyRestoreD1({...d1,active_count:6,paused_count:7}),/restore blocked/i);
});
test('Native six status pages must be complete and empty',()=>{
  const response={result:[],result_info:{count:0,total_count:0,per_page:100}};
  for(const state of ['queued','running','paused','waiting','waitingForPause','rollingBack'])assert.equal(verifyRestoreNative(response,state),true);
  for(const p of [
    {result:[],result_info:{count:0,total_count:1,per_page:100}},
    {result:[{id:'x'}],result_info:{count:1,total_count:1,per_page:100}},
    {result:[],result_info:{count:0,total_count:0,per_page:99}},
    {result:[],result_info:{count:0,total_count:0,per_page:100,cursor:'next'}},
  ])assert.throws(()=>verifyRestoreNative(p,'running'),/restore blocked/i);
});
test('offline D1 SELECT proves five immutable business Plans and fails on one changed Plan',()=>{
  assert.match(restoreReadinessSql,/^SELECT\b/);
  assert.doesNotMatch(restoreReadinessSql,/\b(?:INSERT|UPDATE|DELETE|DROP|ALTER)\s+(?:INTO|FROM|TABLE)?\b/i);
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE workflows(id TEXT,state TEXT,active_version_id TEXT,deleted_at INTEGER);
    CREATE TABLE workflow_versions(id TEXT,workflow_id TEXT);
    CREATE TABLE d1_migrations(name TEXT);
    CREATE TABLE runs(outcome TEXT);
    CREATE TABLE session_executions(state TEXT);`);
  const insert=db.prepare('INSERT INTO workflows VALUES (?,?,?,NULL)');
  const expected=[
    ['7a65cec7-f543-4df6-953d-3ffd3ec6d140','737cda64-6001-49e3-8b63-eb7c0fd252f3'],
    ['98f6ded3-796e-45cd-9ea4-dcc7e28fcaac','ab12fb0f-cc18-495b-948b-f1a096a74097'],
    ['d98035d5-61fc-4da6-a573-80f4ba7a7e9c','465a8021-168a-4b4b-9b70-7cf2e06c8bbd'],
    ['4c3b0ab3-e41e-442a-8a73-2364889a8058','ebe0fc88-35a7-46ca-83e3-1ef20c56a78c'],
    ['00b1e052-f383-4d26-bef2-db49a97c72b9','b00861dc-b6ed-4be1-b203-e4c1b7e3a84c'],
  ];
  for(const [id,plan] of expected)insert.run(id,'active',plan);
  insert.run('0015e2e9-431d-4465-9adf-03191cb382f9','paused','88071284-b7f3-4553-afe4-1ed3fc47972e');
  for(let i=0;i<7;i++)insert.run('historical-'+i,'paused','historical-plan-'+i);
  db.exec(`INSERT INTO workflow_versions VALUES ('88071284-b7f3-4553-afe4-1ed3fc47972e','0015e2e9-431d-4465-9adf-03191cb382f9');`);
  const migration=db.prepare('INSERT INTO d1_migrations VALUES (?)');
  for(let i=0;i<20;i++)migration.run('migration-'+i);
  migration.run('0021_retire_uu_session_data.sql');
  for(let i=0;i<12;i++)db.exec("INSERT INTO runs VALUES ('indeterminate')");
  const row=()=>Object.fromEntries(Object.entries(db.prepare(restoreReadinessSql).get()).map(([k,v])=>[k,Number.isInteger(v)?v:Number(v)||v]));
  assert.equal(verifyRestoreD1(row()),true);
  db.prepare('UPDATE workflows SET active_version_id=? WHERE id=?').run('changed-plan',expected[0][0]);
  assert.equal(row().unchanged_other_plans,4);
  assert.throws(()=>verifyRestoreD1(row()),/restore blocked/i);
  db.close();
});

test('Only historical Version143 and new code-only restore share existing Release Worker lock',()=>{
  const yaml=readFileSync(new URL('../.github/workflows/release.yml',import.meta.url),'utf8');
  const job=yaml.split('  legacy-secret-cleanup:')[1];
  const normal=yaml.slice(yaml.indexOf('  deploy:'),yaml.indexOf('  legacy-secret-cleanup:'));
  assert.match(normal,/inputs.legacy_secret_cleanup_mode == 'none'/);
  assert.match(job,/inputs.workflow_code_only == true/);
  assert.match(job,/inputs.uu_session_secret_cleanup != true/);
  assert.match(job,/workflow-version-restore.mjs preflight/);
  assert.match(job,/workflow-version-restore.mjs readback/);
  assert.match(job,/workflow-uu-secret-cleanup.mjs restore-preflight/);
  assert.match(job,/workflow-uu-secret-cleanup.mjs restore-readback/);
  assert.match(job,/group: worker-release-\$\{\{ inputs.worker \}\}/);
  assert.match(job,/cancel-in-progress: false/);
  assert.match(job,/needs.checks.result == 'success'/);
  assert.match(job,/needs.checks.outputs.release_ready == 'true'/);
  assert.match(job,/wrangler versions deploy/);
  assert.doesNotMatch(job,/wrangler d1 migrations apply|gh secret delete|wrangler secret delete/);
  const script=readFileSync(new URL('./workflow-version-restore.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(script,/method:\s*['"](?:PUT|PATCH|DELETE)['"]/);
  assert.doesNotMatch(script,/wrangler versions deploy|wrangler deploy/);
});
