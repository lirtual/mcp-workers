import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyUuCleanupGuard,verifyUuSecretCandidate} from './workflow-uu-cleanup-gate.mjs';

const sha='a'.repeat(40);
const oldVersion='3883c6bf-0581-4e3a-8b58-ed8e5ec9f1ba';
const bindings=[
  {name:'ACTIONS',type:'service',service:'cloudflare-actions'},
  {name:'DB',type:'d1',id:'a4a477cd-6339-478c-ab7c-f7d87bb0d772'},
  {name:'WORKFLOW',type:'workflow',workflow_name:'workflow-mcp-orchestrator'},
  {name:'WORKFLOW_GITHUB_ACTION_APPROVED_REPOSITORIES',type:'plain_text'},
  {name:'WORKFLOW_GITHUB_ACTION_OIDC_AUDIENCE',type:'plain_text'},
  {name:'WORKFLOW_MCP_PORTAL_CLIENT_ID',type:'plain_text'},
  {name:'WORKFLOW_MCP_PORTAL_ENDPOINT',type:'plain_text'},
  {name:'MCP_ACCESS_TOKEN',type:'secret_text'},
  {name:'WORKFLOW_GITHUB_DISPATCH_TOKEN',type:'secret_text'},
  {name:'WORKFLOW_MCP_PORTAL_CLIENT_SECRET',type:'secret_text'},
  {name:'WORKFLOW_SESSION_RUNTIME_DATA_KEY',type:'secret_text'},
];
const migration={
  migration_count:20,expected_migrations:20,workflow_count:14,run_count:12,
  session_count:2,attempt_count:12,callback_count:0,cancellation_count:0,nonterminal_runs:0,
  unresolved_starts:0,unresolved_steps:0,nonterminal_attempts:0,
  nonterminated_sessions:0,undelivered_callbacks:0,invalid_cancelled_steps:0,
};
const cleanup={
  migration_count:20,migration_v10:1,migration_v20:1,migration_v21:0,
  table_present:1,table_rows:0,active_sessions:0,pending_windows_attempts:0,
  windows_state:'paused',retired_rca_tombstoned:1,retired_rca_version_exists:1,
};
const snapshot=()=>({expectedSha:sha,sourceSha:sha,expectedVersion:oldVersion,
  deployment:{deployments:[{versions:[{version_id:oldVersion,percentage:100}]}]},
  version:{id:oldVersion,resources:{bindings:structuredClone(bindings)}},
  cleanupRow:{...cleanup},migrationResponse:[{success:true,results:[{...migration}]}]});

test('UU retirement authorizes only empty table, fenced old Plan and exact production version after the existing migration gate',()=>{
  assert.equal(verifyUuCleanupGuard(snapshot()),true);
  for(const [field,value] of [['table_rows',1],['active_sessions',1],['pending_windows_attempts',1],
    ['retired_rca_tombstoned',0],['retired_rca_version_exists',0],
    ['windows_state','active'],['migration_count',21],['migration_v10',0],
    ['migration_v21',1],['table_present',0]]) {
    const x=snapshot();x.cleanupRow[field]=value;
    assert.throws(()=>verifyUuCleanupGuard(x),/UU cleanup/,'must reject '+field);
  }
  const changed=snapshot();changed.sourceSha='b'.repeat(40);
  assert.throws(()=>verifyUuCleanupGuard(changed),/UU cleanup/);
  const drift=snapshot();drift.deployment.deployments[0].versions[0].percentage=50;
  assert.throws(()=>verifyUuCleanupGuard(drift),/UU cleanup/);
  const extra=snapshot();extra.version.resources.bindings.push({name:'UNREVIEWED',type:'secret_text'});
  assert.throws(()=>verifyUuCleanupGuard(extra),/UU cleanup/);
});

test('twelve historical indeterminate Runs remain a hard blocker even when the UU table is empty',()=>{
  const s=snapshot();s.migrationResponse[0].results[0].nonterminal_runs=12;
  assert.throws(()=>verifyUuCleanupGuard(s),/Workflow migration blocked by nonterminal_runs/);
  const q=snapshot();q.migrationResponse[0].results[0].nonterminal_attempts=1;
  assert.throws(()=>verifyUuCleanupGuard(q),/Workflow migration blocked by nonterminal_attempts/);
});

test('UU runtime Secret candidate must remove exactly one binding and preserve every other binding',()=>{
  const base={id:oldVersion,number:141,resources:{script:{etag:'etag'},bindings}};
  const candidate={id:'414da2d7-a16f-4ce6-9350-013ad4f7166a',number:142,
    resources:{script:{etag:'etag'},bindings:bindings.filter(b=>b.name!=='WORKFLOW_SESSION_RUNTIME_DATA_KEY')}};
  assert.equal(verifyUuSecretCandidate(base,candidate),true);
  assert.throws(()=>verifyUuSecretCandidate(base,{...candidate,resources:{...candidate.resources,bindings}}),/UU Secret candidate/);
  assert.throws(()=>verifyUuSecretCandidate(base,{...candidate,resources:{...candidate.resources,bindings:candidate.resources.bindings.filter(b=>b.name!=='WORKFLOW_MCP_PORTAL_CLIENT_SECRET')}}),/UU Secret candidate/);
  assert.throws(()=>verifyUuSecretCandidate(base,{...candidate,resources:{...candidate.resources,script:{etag:'other'}}}),/UU Secret candidate/);
});

test('migration 0021 deletes only the retired UU table while preserving arbitrary Run and audit data',async()=>{
  const {DatabaseSync}=await import('node:sqlite');
  const {readFileSync}=await import('node:fs');
  const db=new DatabaseSync(':memory:');
  db.exec("CREATE TABLE session_runtime_data (run_id TEXT); CREATE TABLE runs (id TEXT); INSERT INTO runs VALUES ('historic-indeterminate');");
  const sql=readFileSync(new URL('../apps/workflow-mcp-worker/migrations/0021_retire_uu_session_data.sql',import.meta.url),'utf8');
  assert.match(sql,/DROP TABLE session_runtime_data;/);
  assert.doesNotMatch(sql,/DROP TABLE runs|DELETE FROM|UPDATE |DROP TABLE IF EXISTS/i);
  db.exec(sql);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='session_runtime_data'").get().n,0);
  assert.equal(db.prepare('SELECT id FROM runs').get().id,'historic-indeterminate');
  db.close();
});

test('protected release fences both migration callers before applying 0021 and retains full unknown-state checks',async()=>{
  const {readFileSync}=await import('node:fs');
  const release=readFileSync(new URL('../.github/workflows/release.yml',import.meta.url),'utf8');
  const source=readFileSync(new URL('./manual-worker-release.mjs',import.meta.url),'utf8');
  const guard=release.indexOf('Fence Spec 774 UU table retirement before any migration');
  const apply=release.indexOf('      - name: Apply complete Workflow D1 migrations');
  const oldBlock=release.indexOf('Block legacy Actions migration prepare once destructive UU migration is staged');
  const oldApply=release.indexOf('      - name: Apply existing Workflow D1 migrations and freeze only 0018');
  assert.ok(guard>0 && apply>guard && oldBlock>0 && oldApply>oldBlock);
  assert.match(release,/\[\[ "\$UU_CLEANUP_APPROVED" == "true" \]\]/);
  assert.match(release,/UU_CLEANUP_EXPECTED_SHA/);
  assert.match(release,/UU_CLEANUP_EXPECTED_ACTIVE_VERSION/);
  assert.match(release,/UU_REQUIRE_CLEANUP_COMPLETE: 'true'/);
  assert.match(release,/UU_REQUIRE_CLEANUP_COMPLETE: \$\{\{ inputs.workflow_code_only \}\}/);
  assert.doesNotMatch(release,/^\s*(?:pnpm exec wrangler secret delete|gh secret delete)/m);
  assert.match(source,/verifyWorkflowMigrationReadiness/);
  assert.match(source,/Workflow migration blocked by/);
  assert.match(source,/const completeV21=/);
});
