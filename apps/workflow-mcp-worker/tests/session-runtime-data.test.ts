import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {SignJWT,generateKeyPair} from 'jose';
import {handleSignedSessionDataReport,getSessionRuntimeData} from '../src/session-runtime-data.ts';
import type {Env} from '../src/store.ts';

const attemptId='11111111-1111-4111-8111-111111111111';
const runId='22222222-2222-4222-8222-222222222222';
const key='uu.credentials';
const stepId='windows';
const audience='workflow-github-action:production';
const repository='lirtual/github-actions';
const workflowPath='.github/workflows/windows.yml';
const ref='refs/tags/spec288-test';
const sha='a'.repeat(40);
const action={repository,repositoryId:123,workflowId:45,workflowPath,commitSha:sha,
 type:'session',contractDigest:'b'.repeat(64)};
const claims={repository,repository_id:'123',workflow_ref:repository+'/'+workflowPath+'@'+ref,
 ref,sha,run_id:'42',run_attempt:'1',event_name:'workflow_dispatch'};
const value={device_id:'123456789',verification_code:'AB12CD34'};
const alternate={device_id:'123456789',verification_code:'CD34EF56'};
const invite='https://uuyc.163.com/invite/'+'a4'.repeat(16);
const withInvite={...value,share_url:invite};

function fixture(){
 const db=new DatabaseSync(':memory:');
 db.exec(`
 CREATE TABLE workflow_versions(id TEXT PRIMARY KEY,plan TEXT NOT NULL);
 CREATE TABLE runs(id TEXT PRIMARY KEY,version_id TEXT NOT NULL,outcome TEXT NOT NULL);
 CREATE TABLE step_attempts(
  attempt_id TEXT PRIMARY KEY,run_id TEXT,step_id TEXT,state TEXT,
  capability_id TEXT,repository TEXT,repository_id TEXT,workflow_ref TEXT,ref TEXT,
  candidate_run_id INTEGER,candidate_run_attempt INTEGER,
  owner_run_id INTEGER,owner_run_attempt INTEGER
 );
 CREATE TABLE session_executions(run_id TEXT,step_id TEXT,state TEXT,
  PRIMARY KEY(run_id,step_id));
 CREATE TABLE github_action_cancellations(attempt_id TEXT PRIMARY KEY);
 `);
 db.exec(readFileSync(new URL('../migrations/0010_session_runtime_data.sql',import.meta.url),'utf8'));
 const plan={github_execution_approved:true,github_action_approvals:[action],
  steps:[{id:stepId,uses:'github.run',with:{capability:'github.action',
   action:{...action,ref,inputs:{duration_minutes:5}}}}]};
 db.prepare('INSERT INTO workflow_versions VALUES (?,?)').run('v',JSON.stringify(plan));
 db.prepare('INSERT INTO runs VALUES (?,?,?)').run(runId,'v','succeeded');
 db.prepare('INSERT INTO step_attempts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
  .run(attemptId,runId,stepId,'claimed','github.action',repository,'123',
   claims.workflow_ref,ref,42,1,42,1);
 db.prepare('INSERT INTO session_executions VALUES (?,?,?)').run(runId,stepId,'ready');
 const d1={
  prepare:(sql:string)=>({
   bind:(...params:unknown[])=>{
    const statement=db.prepare(sql);
    return {
     first:async<T>()=>(statement.get(...(params as []))??null) as T|null,
     run:async()=>({meta:{changes:Number(statement.run(...(params as [])).changes)}}),
    };
   },
  }),
 } as unknown as D1Database;
 const env={DB:d1,GITHUB_ACTION_OIDC_AUDIENCE:audience,
  SESSION_RUNTIME_DATA_KEY:Buffer.alloc(32,7).toString('base64'),
  WORKFLOW_GITHUB_DISPATCH_TOKEN:'test-physical-inspection-token'} as Env;
 const stored=()=>db.prepare('SELECT * FROM session_runtime_data').get() as
  Record<string,unknown>|undefined;
 return {db,env,stored};
}
async function sender(claimOverrides:Record<string,unknown>={}){
 const {privateKey,publicKey}=await generateKeyPair('RS256');
 const jwt=await new SignJWT({...claims,...claimOverrides}).setProtectedHeader({alg:'RS256'})
  .setIssuer('https://token.actions.githubusercontent.com')
  .setAudience(audience).setIssuedAt().setExpirationTime('5m').sign(privateKey);
 const send=(env:Env,sequence:number,status:'ready'|'unavailable',data:unknown=value,
    override:Record<string,unknown>={})=>
  handleSignedSessionDataReport(new Request('https://workflow.example.org/github/action/session-data',{
   method:'POST',headers:{authorization:'Bearer '+jwt},
   body:JSON.stringify({...{attemptId,key,sequence,status},
    ...(status==='ready'?{value:data}:{}),...override}),
  }),env,publicKey);
 return {send,publicKey,jwt};
}
const physicalRunning=async()=>({state:'running' as const});
const physicalUnknown=async()=>({state:'unknown' as const});

test('strict OIDC ingress ignores invalid payload and does not write sensitive data',async()=>{
 const {env,stored}=fixture();
 const {send}=await sender();
 assert.equal((await send(env,1,'ready',value,{extra:true})).status,400);
 assert.equal((await send(env,1,'ready',{device_id:'123',verification_code:'AB12CD34'})).status,400);
 assert.equal((await send(env,1,'ready',{device_id:'123456789',verification_code:'12345678'})).status,400);
 for(const invalid of [
  'http://uuyc.163.com/invite/'+'a4'.repeat(16),
  invite+'?next=https://example.com',
  'https://uuyc.163.com.evil.com/invite/'+'a4'.repeat(16),
  'https://uuyc.163.com/invite/'+'Z'.repeat(32),
 ]){
  assert.equal((await send(env,1,'ready',{...value,share_url:invalid})).status,400);
 }
 assert.equal((await send(env,1,'ready',{...value,share_url:null})).status,400);
 assert.equal((await send(env,1,'ready',{...withInvite,extra:true})).status,400);
 assert.equal((await send(env,1,'ready',value,{key:'other'})).status,400);
 assert.equal((await send(env,0,'ready')).status,400);
 assert.equal((await send(env,1,'ready',value,{attemptId:['11111111-1111-4111-8111-111111111111']})).status,400);
 assert.equal(stored(),undefined);
 const unauthorized=new Request('https://example.org/github/action/session-data',{method:'POST',
  body:JSON.stringify({attemptId,key,sequence:1,status:'ready',value})});
 assert.equal((await handleSignedSessionDataReport(unauthorized,env)).status,401);
 const oversized=new Request('https://example.org/github/action/session-data',{method:'POST',
  headers:{authorization:'Bearer x'},body:'x'.repeat(8193)});
 assert.equal((await handleSignedSessionDataReport(oversized,env)).status,413);
});

test('parent Workflow succeeded: signed current Session can renew, rotate and tombstone safely',async()=>{
 const {env,db,stored}=fixture();
 const {send}=await sender();
 assert.deepEqual(await (await send(env,1,'ready')).json(),{result:'recorded'});
 const first=stored()!;
 assert.equal(first.sequence,1);
 assert.equal(first.ciphertext?.toString().includes(value.verification_code),false);
 assert.notEqual(first.iv,null);
 const data=await getSessionRuntimeData(env,runId,stepId,key,physicalRunning);
 assert.deepEqual(data.status,'ready');
 if(data.status==='ready')assert.deepEqual(data.data,value);
 assert.deepEqual(await (await send(env,1,'ready')).json(),{result:'already_recorded'});
 assert.deepEqual(stored()!.expires_at,first.expires_at);
 assert.deepEqual(await (await send(env,1,'ready',alternate)).json(),{result:'denied'});
 assert.deepEqual(await (await send(env,2,'ready')).json(),{result:'recorded'});
 assert.equal(stored()!.sequence,2);
 assert.notEqual(stored()!.iv,first.iv);
 assert.deepEqual(await (await send(env,3,'unavailable')).json(),{result:'recorded'});
 assert.equal(stored()!.ciphertext,null);
 assert.deepEqual(await getSessionRuntimeData(env,runId,stepId,key,physicalRunning),
  {status:'unavailable',reason:'capture_unavailable'});
 assert.equal((await send(env,2,'ready')).status,403);
 assert.deepEqual(await (await send(env,3,'unavailable')).json(),{result:'already_recorded'});
 assert.deepEqual(await (await send(env,4,'ready',alternate)).json(),{result:'recorded'});
 assert.equal(stored()!.sequence,4);
 const rotated=await getSessionRuntimeData(env,runId,stepId,key,physicalRunning);
 if(rotated.status==='ready')assert.deepEqual(rotated.data,alternate);
 else assert.fail('current credentials must be readable');
 db.close();
});

test('optional UU invite link is encrypted, TTL-gated, backward-compatible and owner-readable',async()=>{
 const {env,db,stored}=fixture();
 const {send}=await sender();
 assert.equal((await send(env,1,'ready',withInvite)).status,200);
 const encrypted=stored()!;
 assert.equal(encrypted.ciphertext?.toString().includes(invite),false);
 const result=await getSessionRuntimeData(env,runId,stepId,key,physicalRunning);
 assert.equal(result.status,'ready');
 if(result.status==='ready')assert.deepEqual(result.data,withInvite);
 assert.equal((await send(env,1,'ready',withInvite)).status,200);
 assert.equal((await send(env,1,'ready',value)).status,403);
 assert.deepEqual(await getSessionRuntimeData(env,runId,stepId,key,physicalRunning,
  ()=>Date.now()+91_000),{status:'unavailable',reason:'expired'});
 assert.equal((await send(env,2,'ready',value)).status,200);
 const without=await getSessionRuntimeData(env,runId,stepId,key,physicalRunning);
 if(without.status==='ready')assert.deepEqual(without.data,value);
 else assert.fail('legacy reports must still be accepted');
 db.close();
});

test('physical ambiguity, TTL, key rotation, tampering and cancellation fail closed',async()=>{
 const {env,db}=fixture();
 const {send}=await sender();
 assert.equal((await send(env,1,'ready')).status,200);
 assert.deepEqual(await getSessionRuntimeData(env,runId,stepId,key,physicalUnknown),
  {status:'unavailable',reason:'physical_unverified'});
 assert.deepEqual(await getSessionRuntimeData(env,runId,stepId,key,physicalRunning,
  ()=>Date.now()+91_000),{status:'unavailable',reason:'expired'});
 const secret=env.SESSION_RUNTIME_DATA_KEY;
 env.SESSION_RUNTIME_DATA_KEY=Buffer.alloc(32,8).toString('base64');
 assert.deepEqual(await getSessionRuntimeData(env,runId,stepId,key,physicalRunning),
  {status:'unavailable',reason:'unavailable'});
 assert.equal((await send(env,2,'ready')).status,200);
 env.SESSION_RUNTIME_DATA_KEY=secret;
 assert.deepEqual(await getSessionRuntimeData(env,runId,stepId,key,physicalRunning),
  {status:'unavailable',reason:'unavailable'});
 env.SESSION_RUNTIME_DATA_KEY=Buffer.alloc(32,8).toString('base64');
 assert.equal((await send(env,3,'ready')).status,200);
 db.exec("UPDATE session_runtime_data SET ciphertext='AAAA' WHERE run_id='"+runId+"'");
 assert.deepEqual(await getSessionRuntimeData(env,runId,stepId,key,physicalRunning),
  {status:'unavailable',reason:'unavailable'});
 assert.equal((await send(env,4,'ready')).status,200);
 db.prepare('INSERT INTO github_action_cancellations VALUES (?)').run(attemptId);
 assert.equal((await send(env,5,'ready')).status,403);
 assert.deepEqual(await getSessionRuntimeData(env,runId,stepId,key,physicalRunning),
  {status:'unavailable',reason:'not_ready'});
 db.close();
});

test('cancellation or rotation during physical REST check cannot reveal prior data',async()=>{
 const {db,env}=fixture();
 const {send}=await sender();
 assert.equal((await send(env,1,'ready')).status,200);
 const cancelDuringRead=async()=>{
  db.prepare('INSERT INTO github_action_cancellations VALUES (?)').run(attemptId);
  return {state:'running' as const};
 };
 assert.deepEqual(await getSessionRuntimeData(env,runId,stepId,key,cancelDuringRead),
  {status:'unavailable',reason:'not_ready'});
 db.close();

 const second=fixture();
 assert.equal((await send(second.env,1,'ready')).status,200);
 const rotateDuringRead=async()=>{
  assert.equal((await send(second.env,2,'ready',alternate)).status,200);
  return {state:'running' as const};
 };
 assert.deepEqual(await getSessionRuntimeData(second.env,runId,stepId,key,rotateDuringRead),
  {status:'unavailable',reason:'not_ready'});
 second.db.close();
});

test('immutable GitHub OIDC owner and approved Windows Action are both mandatory',async()=>{
 for(const wrong of [
  {sha:'c'.repeat(40)}, {run_id:'43'}, {run_attempt:'2'},
  {repository_id:'999'}, {ref:'refs/tags/another'},
  {workflow_ref:repository+'/.github/workflows/ubuntu.yml@'+ref},
  {event_name:'push'},
 ]){
  const {env,stored,db}=fixture();
  const {send}=await sender(wrong);
  assert.equal((await send(env,1,'ready')).status,403);
  assert.equal(stored(),undefined);
  db.close();
 }
 for(const mutate of [
  (db:DatabaseSync)=>db.exec("UPDATE session_executions SET state='stopping'"),
  (db:DatabaseSync)=>db.exec("UPDATE step_attempts SET state='confirmed'"),
  (db:DatabaseSync)=>db.exec("UPDATE step_attempts SET repository='someone/other'"),
  (db:DatabaseSync)=>db.exec("UPDATE step_attempts SET owner_run_attempt=2"),
 ]){
  const {env,stored,db}=fixture();
  mutate(db);
  const {send}=await sender();
  assert.equal((await send(env,1,'ready')).status,403);
  assert.equal(stored(),undefined);
  db.close();
 }
});
