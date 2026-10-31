import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {workflowGitHubArtifactReferences} from '../src/github-action-artifacts.ts';
import type {Env} from '../src/store.ts';
import type {Plan} from '../src/plan.ts';

const repo='lirtual/session-actions',sha='a'.repeat(40),run='r1';
const action={repository:repo,repositoryId:1430925009,workflowId:395929968,
 workflowPath:'.github/workflows/ubuntu.yml',commitSha:sha,type:'task' as const,
 contractDigest:'b'.repeat(64),ref:'refs/tags/v0.1.42-rc.9',inputs:{}};
const approved={repository:action.repository,repositoryId:action.repositoryId,
 workflowId:action.workflowId,workflowPath:action.workflowPath,commitSha:action.commitSha,
 type:action.type,contractDigest:action.contractDigest};
function fixture(options:{grant?:boolean;attemptState?:string;runAttempt?:number;
 originalStepState?:string;differentRepo?:boolean}={}){
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec(`CREATE TABLE workflow_versions(id TEXT PRIMARY KEY,plan TEXT);
 CREATE TABLE runs(id TEXT PRIMARY KEY,version_id TEXT);
 CREATE TABLE run_steps(run_id TEXT,step_id TEXT,status TEXT);
 CREATE TABLE step_attempts(run_id TEXT,step_id TEXT,capability_id TEXT,state TEXT,
 repository TEXT,repository_id TEXT,workflow_ref TEXT,ref TEXT,owner_run_id INTEGER,
 owner_run_attempt INTEGER,candidate_run_id INTEGER,candidate_run_attempt INTEGER);`);
 const plan:Plan={version:1,name:'Artifact fixture',steps:[{id:'build',uses:'github.run',needs:[],
  with:{capability:'github.action',action}}],github_execution_approved:true,
  github_action_approvals:options.grant===false?[]:[approved]};
 sqlite.prepare(`INSERT INTO workflow_versions VALUES ('v',?)`).run(JSON.stringify(plan));
 sqlite.exec(`INSERT INTO runs VALUES ('r1','v')`);
 sqlite.prepare(`INSERT INTO run_steps VALUES ('r1','build',?)`).run(options.originalStepState??'succeeded');
 sqlite.prepare(`INSERT INTO step_attempts VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(run,'build',
   'github.action',options.attemptState??'succeeded',options.differentRepo?'other/repo':repo,
   String(action.repositoryId),repo+'/'+action.workflowPath+'@'+action.ref,
   action.ref,42,options.runAttempt??1,42,options.runAttempt??1);
 const db={prepare(sql:string){let args:unknown[]=[];return {
  bind(...values:unknown[]){args=values;return this;},
  async first<T>(){return sqlite.prepare(sql).get(...args as []) as T|null;},
  async all<T>(){return {results:sqlite.prepare(sql).all(...args as []) as T[]};},
 };}} as unknown as Env['DB'];
 return {sqlite,db};
}
function artifact(overrides:Record<string,unknown>={}){
 return {id:777,name:'verified-build',size_in_bytes:1024,expired:false,
 expires_at:new Date(Date.now()+86_400_000).toISOString(),
 digest:'sha256:'+'c'.repeat(64),workflow_run:{id:42,
 repository_id:1430925009,head_repository_id:1430925009,head_sha:sha},...overrides};
}
const response=(artifacts:unknown[])=>Response.json({total_count:artifacts.length,artifacts});
const physical=(runAttempt=1)=>Response.json({id:42,workflow_id:action.workflowId,
 run_attempt:runAttempt,repository:{id:action.repositoryId,full_name:repo},
 path:action.workflowPath,head_sha:sha,head_branch:'v0.1.42-rc.9',
 event:'workflow_dispatch',status:'completed',conclusion:'success'});
const serve=(artifacts:unknown[],runAttempt=1)=>async(req:Request)=>
 req.url.includes('/artifacts?')?response(artifacts):physical(runAttempt);

test('verified artifact metadata is bound to the exact pinned successful Task, without download URLs',async t=>{
 const {sqlite,db}=fixture();t.after(()=>sqlite.close());
 let requests=0;
 const http=async(request:Request)=>{
  requests++;
  assert.equal(request.redirect,'manual');
  assert.equal(request.method,'GET');
  assert.ok(request.url.startsWith('https://api.github.com/repos/lirtual/session-actions/actions/runs/42'));
  assert.equal(request.headers.get('authorization'),'Bearer test-token');
  return request.url.includes('/artifacts?')?
    response([{...artifact(),archive_download_url:'https://secret.example/download?token=private'}]):physical();
 };
 const out=await workflowGitHubArtifactReferences(db,run,'test-token',http);
 assert.equal(requests,2);
 assert.equal(out.length,1);
 assert.equal(out[0]?.status,'verified');
 assert.deepEqual(out[0]?.references.map(x=>({step:x.repository,run:x.workflow_run_id,id:x.artifact_id,auth:x.requires_auth})),
  [{step:repo,run:42,id:777,auth:'github_actions_read'}]);
 assert.equal(JSON.stringify(out).includes('secret.example'),false);
 assert.equal(JSON.stringify(out).includes('test-token'),false);
 assert.equal(JSON.stringify(out).includes('archive_download_url'),false);
});

test('unknown or mismatched artifact provenance never becomes a verified reference',async t=>{
 const {sqlite,db}=fixture();t.after(()=>sqlite.close());
 for(const invalid of [
  artifact({workflow_run:{id:43,repository_id:1430925009,head_sha:sha}}),
  artifact({workflow_run:{id:42,repository_id:1430925009,head_sha:'d'.repeat(40)}}),
  artifact({expired:true}),
  artifact({expires_at:'2020-01-01T00:00:00Z'}),
  artifact({digest:'invalid'}),
 ]){
  const out=await workflowGitHubArtifactReferences(db,run,'test-token',serve([invalid]));
  assert.deepEqual(out,[{step_id:'build',status:'unavailable',references:[]}]);
 }
 assert.deepEqual(await workflowGitHubArtifactReferences(db,run,'test-token',async(req)=>req.url.includes('/artifacts?')?new Response(null,{status:302}):physical()),
  [{step_id:'build',status:'unavailable',references:[]}]);
 assert.deepEqual(await workflowGitHubArtifactReferences(db,run,'test-token',serve([])),
  [{step_id:'build',status:'none',references:[]}]);
});

test('a later GitHub rerun prevents trusting artifacts from the same Run ID',async t=>{
 const {sqlite,db}=fixture();t.after(()=>sqlite.close());
 let calls=0;
 const out=await workflowGitHubArtifactReferences(db,run,'test-token',async req=>{
  calls++;
  assert.equal(req.url.includes('/artifacts?'),false,
   'mismatched physical run must not query artifacts');
  return physical(2);
 });
 assert.deepEqual(out,[{step_id:'build',status:'unavailable',references:[]}]);
 assert.equal(calls,1);
});

test('missing exact grants or physical success, other repositories and reruns cannot leak artifacts',async()=>{
 for(const cfg of [{grant:false},{attemptState:'claimed'},{originalStepState:'running'},
  {runAttempt:2},{differentRepo:true}]){
  const {sqlite,db}=fixture(cfg);
  let calls=0;
  const out=await workflowGitHubArtifactReferences(db,run,'test-token',async()=>{calls++;return response([artifact()]);});
  assert.deepEqual(out,[]);
  assert.equal(calls,0);
  sqlite.close();
 }
});
