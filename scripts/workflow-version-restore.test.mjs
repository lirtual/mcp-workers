import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {REVIEWED_HISTORICAL_RUN_IDS} from './legacy-secret-cleanup.mjs';
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
// 仅包含历史受审状态代码，不包含 inputs、凭据或业务数据。
const historicalAudit=[
 ['0bb5f19e-627e-440d-9757-7dfd9a0af31d','cloudflare_dispatch_unconfirmed','notify_weixin','indeterminate'],
 ['22625b58-e260-4988-81b6-04352a2d5f11','cloudflare_outcome_unknown','notify','indeterminate'],
 ['29e121ab-de3e-43dd-b3bb-6e6d495fa2b1','github_session_no_ready','ubuntu','indeterminate'],
 ['391e075f-3d5c-449e-ad88-fa13c6d4eb6d','execution_interrupted','create_note','running'],
 ['3e312105-b40e-49ea-a037-c3359074be2b','cloudflare_outcome_unknown','notify','indeterminate'],
 ['47739981-0534-4966-8034-1e79c1d17481','github_session_no_ready','openlist_session','indeterminate'],
 ['5813140e-6559-469c-8e0a-d6800ff33331','cloudflare_outcome_unknown','notify','indeterminate'],
 ['8e0a94a7-136f-41fd-b839-211c9a60ad49','cloudflare_outcome_unknown','notify','indeterminate'],
 ['9da5816a-e7d9-481a-8203-3a2036534563','cloudflare_outcome_unknown','notify','indeterminate'],
 ['a1970556-a529-46c2-9bb1-81980b51557e','cloudflare_outcome_unknown','notify','indeterminate'],
 ['eab7b71f-b857-4569-afde-fd269cd1b2bb','github_dispatch_unknown','ubuntu','indeterminate'],
 ['f99bb918-2909-46df-b196-d07faa64df27','github_dispatch_unknown','verify','indeterminate'],
];
assert.deepEqual(historicalAudit.map(x=>x[0]).sort(),[...REVIEWED_HISTORICAL_RUN_IDS].sort());
const historicalEvidence={
 run_proof:historicalAudit.map(([id,error])=>`${id}:indeterminate:started:${error}`).join('|'),
 step_proof:historicalAudit.map(([id,error,step,status])=>
  `${id}:${step}:${status}:${status==='running'?'':error}`).join('|'),
 attempt_proof:'f99bb918-2909-46df-b196-d07faa64df27:verify:claimed:41182432750',
};
const d1={migration_count:21,migration_v21:1,old_table:0,unresolved_runs:0,unknown_runs:12,reviewed_unknown_runs:12,unreviewed_runs:0,active_sessions:0,openlist_state:'paused',openlist_version:'88071284-b7f3-4553-afe4-1ed3fc47972e',original_plan:1,unchanged_other_plans:5,active_count:0,paused_count:13,...historicalEvidence};

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
    CREATE TABLE runs(id TEXT PRIMARY KEY,outcome TEXT,start_state TEXT,error_code TEXT);
    CREATE TABLE run_steps(run_id TEXT,step_id TEXT,status TEXT,error_code TEXT);
    CREATE TABLE step_attempts(run_id TEXT,step_id TEXT,state TEXT,owner_run_id INTEGER);
    CREATE TABLE session_executions(state TEXT);`);
  const insert=db.prepare('INSERT INTO workflows VALUES (?,?,?,NULL)');
  const expected=[
    ['7a65cec7-f543-4df6-953d-3ffd3ec6d140','737cda64-6001-49e3-8b63-eb7c0fd252f3'],
    ['98f6ded3-796e-45cd-9ea4-dcc7e28fcaac','ab12fb0f-cc18-495b-948b-f1a096a74097'],
    ['d98035d5-61fc-4da6-a573-80f4ba7a7e9c','465a8021-168a-4b4b-9b70-7cf2e06c8bbd'],
    ['4c3b0ab3-e41e-442a-8a73-2364889a8058','ebe0fc88-35a7-46ca-83e3-1ef20c56a78c'],
    ['00b1e052-f383-4d26-bef2-db49a97c72b9','b00861dc-b6ed-4be1-b203-e4c1b7e3a84c'],
  ];
  for(const [id,plan] of expected)insert.run(id,'paused',plan);
  insert.run('0015e2e9-431d-4465-9adf-03191cb382f9','paused','88071284-b7f3-4553-afe4-1ed3fc47972e');
  for(let i=0;i<7;i++)insert.run('historical-'+i,'paused','historical-plan-'+i);
  db.exec(`INSERT INTO workflow_versions VALUES ('88071284-b7f3-4553-afe4-1ed3fc47972e','0015e2e9-431d-4465-9adf-03191cb382f9');`);
  const migration=db.prepare('INSERT INTO d1_migrations VALUES (?)');
  for(let i=0;i<20;i++)migration.run('migration-'+i);
  migration.run('0021_retire_uu_session_data.sql');
  const historicalRun=db.prepare('INSERT INTO runs VALUES (?,?,?,?)');
  const historicalStep=db.prepare('INSERT INTO run_steps VALUES (?,?,?,?)');
  for(const [id,error,step,status] of historicalAudit){
    historicalRun.run(id,'indeterminate','started',error);
    historicalStep.run(id,step,status,status==='running'?null:error);
  }
  db.prepare('INSERT INTO step_attempts VALUES (?,?,?,?)')
    .run('f99bb918-2909-46df-b196-d07faa64df27','verify','claimed',41182432750);
  const row=()=>Object.fromEntries(Object.entries(db.prepare(restoreReadinessSql).get()).map(([k,v])=>[k,Number.isInteger(v)?v:Number(v)||v]));
  assert.equal(verifyRestoreD1(row()),true);
  for(const [table,field,where,value] of [
    ['runs','start_state',`id='${historicalAudit[0][0]}'`,'reserved'],
    ['runs','error_code',`id='${historicalAudit[0][0]}'`,'different_error'],
    ['run_steps','status',`run_id='${historicalAudit[0][0]}'`,'running'],
    ['run_steps','error_code',`run_id='${historicalAudit[0][0]}'`,'changed'],
    ['step_attempts','state',`run_id='${historicalAudit[11][0]}'`,'confirmed'],
    ['step_attempts','owner_run_id',`run_id='${historicalAudit[11][0]}'`,123],
  ]){
    db.exec('SAVEPOINT proof_change');
    db.prepare(`UPDATE ${table} SET ${field}=? WHERE ${where}`).run(value);
    assert.throws(()=>verifyRestoreD1(row()),/restore blocked/i,`${table}.${field}`);
    db.exec('ROLLBACK TO proof_change; RELEASE proof_change');
  }
  // 同样的 Unknown 总数不能掩盖新的活动 Run。
  for(const outcome of ['queued','running',null,'unexpected']){
    historicalRun.run('new-run',outcome,'reserved','test');
    assert.throws(()=>verifyRestoreD1(row()),/restore blocked/i);
    db.prepare('DELETE FROM runs WHERE id=?').run('new-run');
  }
  // 同数量替换 Unknown 的身份也必须失败。
  const historicalId=REVIEWED_HISTORICAL_RUN_IDS[0];
  db.prepare('UPDATE runs SET id=? WHERE id=?').run('replacement',historicalId);
  assert.equal(row().unknown_runs,12);
  assert.throws(()=>verifyRestoreD1(row()),/restore blocked/i);
  db.prepare('UPDATE runs SET id=? WHERE id=?').run(historicalId,'replacement');
  // 固定历史 Run 变成普通终态或活动状态均拒绝。
  for(const outcome of ['succeeded','failed','cancelled','queued','running',null]){
    db.prepare('UPDATE runs SET outcome=? WHERE id=?').run(outcome,historicalId);
    assert.throws(()=>verifyRestoreD1(row()),/restore blocked/i);
  }
  db.prepare('UPDATE runs SET outcome=? WHERE id=?').run('indeterminate',historicalId);
  assert.equal(verifyRestoreD1(row()),true);
  db.prepare('UPDATE workflows SET active_version_id=? WHERE id=?').run('changed-plan',expected[0][0]);
  assert.equal(row().unchanged_other_plans,4);
  assert.throws(()=>verifyRestoreD1(row()),/restore blocked/i);
  db.close();
});

// 在实际 YAML 的条件上执行矩阵，避免仅靠字符串存在获得假阳性。
const releaseJob=()=>readFileSync(new URL('../.github/workflows/release.yml',import.meta.url),'utf8')
  .split('  legacy-secret-cleanup:')[1];
const restoreContext=(codeOnly,uuCleanup)=>({
  github:{event_name:'workflow_dispatch',ref:'refs/heads/main',actor:'lirtual'},
  needs:{checks:{result:'success',outputs:{release_ready:'true'}}},
  inputs:{worker:'workflow-mcp-worker',deploy_to_production:true,
    legacy_secret_cleanup_mode:'restore',workflow_code_only:codeOnly,
    uu_session_secret_cleanup:uuCleanup,actions_old_ingress_quiesced:false,
    actions_migration_prepare:false,actions_gate_reopen:false,uu_cleanup_approved:false},
});
const conditionResult=(expression,context)=>runInNewContext(
  expression.replace(/^\s*\$\{\{/, '').replace(/\}\}\s*$/, '').trim(),context,{timeout:100});
test('actual Release job admits exactly the two mutually exclusive Workflow restore modes',()=>{
  const expression=releaseJob().match(/    if: >-\n([\s\S]*?)    runs-on:/)?.[1];
  assert.ok(expression,'protected restore job condition missing');
  for(const codeOnly of [false,true])for(const uuCleanup of [false,true]){
    const context=restoreContext(codeOnly,uuCleanup);
    assert.equal(conditionResult(expression,context),codeOnly!==uuCleanup,
      JSON.stringify({codeOnly,uuCleanup}));
    for(const worker of ['ssh-mcp-worker','database-mcp-worker','unknown-worker']){
      context.inputs.worker=worker;
      assert.equal(conditionResult(expression,context),false);
    }
  }
});
test('actual Release steps bind each preflight/readback to its restore mode and exclude legacy preflight',()=>{
  const steps=releaseJob().split(/^      - /m).slice(1);
  const select=command=>{
    const matches=steps.filter(step=>step.includes('run: node scripts/'+command+' "$SELECTED_WORKER"'));
    assert.equal(matches.length,1,'one exact step required: '+command);
    return matches[0];
  };
  const guarded=(command,context)=>{
    const expression=select(command).match(/^        if: (.+)$/m)?.[1];
    assert.ok(expression,'explicit condition required: '+command);
    return conditionResult(expression,context);
  };
  for(const codeOnly of [false,true])for(const uuCleanup of [false,true]){
    const context=restoreContext(codeOnly,uuCleanup);
    for(const phase of ['preflight','readback'])
      assert.equal(guarded('workflow-version-restore.mjs '+phase,context),codeOnly&&!uuCleanup);
    for(const phase of ['restore-preflight','restore-readback'])
      assert.equal(guarded('workflow-uu-secret-cleanup.mjs '+phase,context),!codeOnly&&uuCleanup);
    if(codeOnly&&!uuCleanup)
      assert.equal(guarded('legacy-secret-cleanup.mjs preflight',context),false);
  }
  const position=command=>steps.indexOf(select(command));
  const deploy=steps.findIndex(step=>step.includes('wrangler versions deploy'));
  assert.ok(position('workflow-version-restore.mjs preflight')<deploy);
  assert.ok(position('workflow-version-restore.mjs readback')>deploy);
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
  assert.doesNotMatch(job,/wrangler d1 migrations apply|gh secret delete|pnpm exec wrangler secret delete/);
  const script=readFileSync(new URL('./workflow-version-restore.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(script,/method:\s*['"](?:PUT|PATCH|DELETE)['"]/);
  assert.doesNotMatch(script,/wrangler versions deploy|wrangler deploy/);
});

// 生产 Version 143 的 GitHub Deployment SHA。准入谓词必须与该提交相同，
// 新代码里的额外判断不能在回退后继续生效。
const version143Sha='3d033784fb56a409c741762c691b68935cf166fd';
const repoRoot=fileURLToPath(new URL('..',import.meta.url));
const gitShow=file=>execFileSync('git',['show',version143Sha+':'+file],{cwd:repoRoot,encoding:'utf8'});
test('Version 143 admission predicates match the code that would run after rollback',()=>{
  for(const file of [
    'apps/workflow-mcp-worker/src/child-capacity.ts',
    'apps/workflow-mcp-worker/src/scheduled.ts',
    'apps/workflow-mcp-worker/src/webhook.ts',
    'apps/workflow-mcp-worker/src/github-event.ts',
    'apps/workflow-mcp-worker/src/index.ts',
    'apps/workflow-mcp-worker/wrangler.jsonc',
  ])assert.equal(gitShow(file),readFileSync(new URL('../'+file,import.meta.url),'utf8'),file);
  const oldStore=gitShow('apps/workflow-mcp-worker/src/store.ts');
  const newStore=readFileSync(new URL('../apps/workflow-mcp-worker/src/store.ts',import.meta.url),'utf8');
  const slice=(source,start,end)=>source.slice(source.indexOf(start),source.indexOf(end));
  for(const [start,end] of [
    ["async pause(workflow_id:string)","async resume(workflow_id:string)"],
    ["async resume(workflow_id:string)","/** Non-destructive tombstone"],
    ['private async reconcileStart(row:RunRow)','private async settleNativeOutcome'],
  ])assert.equal(slice(oldStore,start,end),slice(newStore,start,end),start);
  const reconcile=slice(newStore,'private async reconcileStart(row:RunRow)','private async settleNativeOutcome');
  assert.match(reconcile,/WORKFLOW\.create/);
  assert.doesNotMatch(reconcile,/state='active'/);
});
