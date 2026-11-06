import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyUuSecretRequest,verifyUuSecretCandidate,verifyUuSecretInventory,
  verifyUuSecretD1,verifyUuSecretNative,verifyUuSecretPostflight} from './workflow-uu-secret-cleanup.mjs';
const old='414da2d7-a16f-4ce6-9350-013ad4f7166a', next='22222222-2222-4222-8222-222222222222';
const sha='a'.repeat(40);
const bindings=[
  {name:'ACTIONS',type:'service',service:'cloudflare-actions',entrypoint:'ActionsEntrypoint'},
  {name:'DB',type:'d1',id:'a4a477cd-6339-478c-ab7c-f7d87bb0d772'},
  {name:'WORKFLOW',type:'workflow',workflow_name:'workflow-mcp-orchestrator',class_name:'WorkflowOrchestrator'},
  {name:'MCP_ACCESS_TOKEN',type:'secret_text'},
  {name:'WORKFLOW_GITHUB_DISPATCH_TOKEN',type:'secret_text'},
  {name:'WORKFLOW_MCP_PORTAL_CLIENT_SECRET',type:'secret_text'},
  {name:'WORKFLOW_SESSION_RUNTIME_DATA_KEY',type:'secret_text'},
  {name:'WORKFLOW_GITHUB_ACTION_APPROVED_REPOSITORIES',type:'plain_text',text:'[]'},
  {name:'WORKFLOW_GITHUB_ACTION_OIDC_AUDIENCE',type:'plain_text',text:'aud'},
  {name:'WORKFLOW_MCP_PORTAL_CLIENT_ID',type:'plain_text',text:'cid'},
  {name:'WORKFLOW_MCP_PORTAL_ENDPOINT',type:'plain_text',text:'https://mcp.lirtual.dpdns.org/mcp'},
];
const baseline=()=>({id:old,number:142,resources:{script:{etag:'same',handlers:['fetch'],named_handlers:[]},script_runtime:{compatibility_date:'2026-09-10'},bindings:structuredClone(bindings)}});
const candidate=()=>({id:next,number:143,resources:{script:{etag:'same',handlers:['fetch'],named_handlers:[]},script_runtime:{compatibility_date:'2026-09-10'},bindings:structuredClone(bindings.filter(x=>x.name!=='WORKFLOW_SESSION_RUNTIME_DATA_KEY'))}});
const req={phase:'prepare',sourceSha:sha,expectedSha:sha,activeVersion:old,candidateVersion:''};
test('requires exact Owner main SHA and distinct Prepare/Publish version identity',()=>{
  assert.equal(verifyUuSecretRequest(req),true);
  assert.equal(verifyUuSecretRequest({...req,phase:'publish',candidateVersion:next}),true);
  for(const input of [{expectedSha:'b'.repeat(40)},{sourceSha:'b'.repeat(40)},{activeVersion:'oops'},{phase:'publish'},{candidateVersion:next},{phase:'prepare',candidateVersion:next}]){
    const changed={...req,...input};if(changed.phase==='publish'&&changed.candidateVersion===next)continue;
    assert.throws(()=>verifyUuSecretRequest(changed),/UU Secret/);
  }
});
test('exact one binding removed, everything else unchanged',()=>{
  assert.equal(verifyUuSecretCandidate(baseline(),candidate()),true);
  for(const change of [
    c=>c.resources.bindings.push({name:'UNREVIEWED',type:'secret_text'}),
    c=>c.resources.bindings.pop(),
    c=>c.resources.script.etag='changed',
    c=>c.resources.script_runtime.compatibility_date='2027-01-01',
    c=>c.resources.bindings.find(x=>x.name==='ACTIONS').service='unknown',
    c=>c.resources.unsafe={compatibility_flags:['override']},
  ]){const c=candidate();change(c);assert.throws(()=>verifyUuSecretCandidate(baseline(),c),/UU Secret/);}
});
test('preflight exact active version and candidate versus latest settings',()=>{
 const oldB=baseline(),nextB=candidate();
 const deployed={deployments:[{versions:[{version_id:old,percentage:100}]}]};
 const inventory=bs=>bs.filter(b=>b.type==='secret_text').map(b=>({name:b.name}));
 assert.equal(verifyUuSecretInventory({baseline:oldB,deployment:deployed,settings:{bindings:bindings},inventory:inventory(bindings),phase:'prepare'}),true);
 assert.equal(verifyUuSecretInventory({baseline:oldB,candidate:nextB,deployment:deployed,settings:{bindings:nextB.resources.bindings},inventory:inventory(nextB.resources.bindings),phase:'publish'}),true);
 assert.throws(()=>verifyUuSecretInventory({baseline:oldB,deployment:{deployments:[{versions:[{version_id:old,percentage:50}]}]},settings:{bindings},inventory:inventory(bindings),phase:'prepare'}),/UU Secret/);
});
test('D1 must be unchanged v20, UU table empty and old Plan tombstoned',()=>{
 const row={migration_count:20,uu_table:1,uu_rows:0,active_sessions:0,unfinished_windows_attempts:0,windows_state:'paused',old_rca_deleted:1,old_version_count:1};
 assert.equal(verifyUuSecretD1(row),true);
 for(const k of Object.keys(row)){const changed={...row,[k]:k==='windows_state'?'active':row[k]===0?1:0};assert.throws(()=>verifyUuSecretD1(changed),/UU Secret/);}
});
test('native Workflow instances must be fully drained including waitingForPause',()=>{
 const empty={result:[],result_info:{count:0,total_count:0,per_page:100}};
 for(const s of ['queued','running','paused','waitingForPause','waiting','rollingBack'])assert.equal(verifyUuSecretNative(empty,s),true);
 for(const bad of [{result:[{id:'run'}],result_info:{count:1,total_count:1,per_page:100}},{result:[],result_info:{count:0,total_count:1,per_page:100}},{result:[],result_info:null},{result:[],result_info:{count:0,total_count:0,per_page:100,cursor:'more'}}])
  assert.throws(()=>verifyUuSecretNative(bad,'running'),/UU Secret/);
});


test('versioned release is fail-closed and cannot alias general Secret or D1 cleanup',async()=>{
 const {readFileSync}=await import('node:fs');
 const release=readFileSync(new URL('../.github/workflows/release.yml',import.meta.url),'utf8');
 const src=readFileSync(new URL('./manual-worker-release.mjs',import.meta.url),'utf8');
 const bootstrap=readFileSync(new URL('./bootstrap-worker-secrets.mjs',import.meta.url),'utf8');
 const wrangler=readFileSync(new URL('../apps/workflow-mcp-worker/wrangler.jsonc',import.meta.url),'utf8');
 const cleanup=release.split('  legacy-secret-cleanup:')[1];
 assert.ok(cleanup);
 assert.match(cleanup,/github.actor == 'lirtual'/);
 assert.match(cleanup,/group: worker-release-/);
 assert.match(cleanup,/cancel-in-progress: false/);
 assert.match(cleanup,/workflow-mcp-worker/);
 assert.match(cleanup,/UU_SESSION_SECRET_CLEANUP/);
 assert.match(cleanup,/WORKFLOW_SESSION_RUNTIME_DATA_KEY\":null/);
 assert.match(cleanup,/workflow-uu-secret-cleanup.mjs preflight/);
 assert.match(cleanup,/workflow-uu-secret-cleanup.mjs candidate/);
 assert.match(cleanup,/workflow-uu-secret-cleanup.mjs readback/);
 assert.match(cleanup,/wrangler versions secret bulk/);
 assert.match(cleanup,/wrangler versions deploy/);
 assert.doesNotMatch(cleanup,/(?:^|\n)\s*(?:pnpm exec wrangler d1 migrations apply|pnpm exec wrangler secret delete|gh secret delete)/m);
 const start=release.indexOf('      - name: Stage selected Worker Secrets for every release');
 const end=release.indexOf('      - name: Stage approved Worker variables',start);
 assert.doesNotMatch(release.slice(start,end),/SESSION_RUNTIME_DATA_KEY/);
 assert.doesNotMatch(wrangler,/WORKFLOW_SESSION_RUNTIME_DATA_KEY/);
 assert.doesNotMatch(bootstrap,/WORKFLOW_SESSION_RUNTIME_DATA_KEY/);
 assert.match(src,/WORKFLOW_MCP_PORTAL_CLIENT_SECRET/);
 assert.doesNotMatch(src.split('export const REQUIRED_SECRETS')[1]?.split('};')[0]??'',/WORKFLOW_SESSION_RUNTIME_DATA_KEY/);
});

test('post Publish independently proves exact 100% candidate, no UU Secret and unchanged other resources',()=>{
 const oldB=baseline(),newB=candidate();
 const deployed={deployments:[{versions:[{version_id:next,percentage:100}]}]};
 const inv=newB.resources.bindings.filter(b=>b.type==='secret_text').map(b=>({name:b.name}));
 const data={baseline:oldB,candidate:newB,deployment:deployed,
   settings:{bindings:newB.resources.bindings},inventory:inv};
 assert.equal(verifyUuSecretPostflight(data),true);
 assert.throws(()=>verifyUuSecretPostflight({...data,deployment:{
   deployments:[{versions:[{version_id:old,percentage:100}]}]}}),/UU Secret/);
 assert.throws(()=>verifyUuSecretPostflight({...data,inventory:[...inv,{name:'WORKFLOW_SESSION_RUNTIME_DATA_KEY'}]}),/UU Secret/);
 assert.throws(()=>verifyUuSecretPostflight({...data,settings:{
   bindings:[...newB.resources.bindings,{name:'WORKFLOW_SESSION_RUNTIME_DATA_KEY',type:'secret_text'}]}}),/UU Secret/);
 assert.throws(()=>verifyUuSecretPostflight({...data,candidate:{...newB,resources:{
   ...newB.resources,script:{etag:'unreviewed-code'}}}}),/UU Secret/);
});
