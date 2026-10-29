import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const dir=new URL('../migrations/',import.meta.url);
const read=(name:string)=>readFileSync(new URL(name,dir),'utf8');
function setup(){
 const db=new DatabaseSync(':memory:');
 db.exec('PRAGMA foreign_keys=ON');
 for(const file of ['0001_s1.sql','0014_workflow_deletion.sql','0002_native_complete_seen.sql','0003_s3_attempt_claim.sql','0004_s3_callback_receipts.sql'])db.exec(read(file));
 db.exec(`INSERT INTO workflows(id,name,draft,draft_revision,state,created_at,updated_at)
 VALUES('wf','test','{}',1,'active',1,1);
 INSERT INTO workflow_versions(id,workflow_id,digest,plan,created_at) VALUES('v','wf','digest','{}',1);
 INSERT INTO runs(id,workflow_id,version_id,instance_id,request_digest,inputs,start_state,outcome,created_at,updated_at)
 VALUES('r','wf','v','inst','digest','{}','started','running',1,1);
 INSERT INTO step_attempts(attempt_id,run_id,step_id,capability_id,dispatch_id,state,
 repository,repository_id,workflow_ref,ref,created_at,updated_at)
 VALUES('a','r','start','heavy.github.echo','d','claimed','lirtual/mcp-workers','123',
 'lirtual/mcp-workers/.github/workflows/ci.yml@refs/heads/main','refs/heads/main',1,1);
 INSERT INTO callback_receipts(callback_id,attempt_id,outcome,result_json,created_at)
 VALUES('cb','a','succeeded','{}',1);`);
 db.exec(read('0005_github_workflow_check.sql'));
 return db;
}
test('migration preserves old Attempt, FK receipt, and enables new capabilities',()=>{
 const db=setup();
 try{
  db.exec('BEGIN');
  db.exec(read('0006_action_attempt_capabilities.sql'));
  db.exec('COMMIT');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal(db.prepare('SELECT capability_id FROM step_attempts WHERE attempt_id=?').get('a')?.capability_id,'heavy.github.echo');
  assert.equal(db.prepare('SELECT attempt_id FROM callback_receipts WHERE callback_id=?').get('cb')?.attempt_id,'a');
  for(const [id,step,capability] of [['b','next','github.workflow.check'],['c','action','github.action']]){
   db.prepare(`INSERT INTO step_attempts(attempt_id,run_id,step_id,capability_id,dispatch_id,state,
     repository,repository_id,workflow_ref,ref,created_at,updated_at)
     VALUES(?,'r',?,?,?,'created','lirtual/mcp-workers','123','wf','ref',1,1)`)
    .run(id,step,capability,id+'-dispatch');
  }
  assert.throws(()=>db.prepare(`INSERT INTO step_attempts(attempt_id,run_id,step_id,capability_id,dispatch_id,state,
    repository,repository_id,workflow_ref,ref,created_at,updated_at)
    VALUES('bad','r','bad','arbitrary.shell','bad-dispatch','created','x','1','w','r',1,1)`).run());
  assert.throws(()=>db.prepare(`INSERT INTO step_attempts(attempt_id,run_id,step_id,capability_id,dispatch_id,state,
    repository,repository_id,workflow_ref,ref,created_at,updated_at)
    VALUES('dup','r','start','github.action','new','created','x','1','w','r',1,1)`).run());
 }finally{db.close();}
});
test('migration rolls back fully on schema conflict',()=>{
 const db=setup();
 try{
  db.exec('CREATE TABLE step_attempts_replacement (x TEXT)');
  db.exec('BEGIN');
  assert.throws(()=>db.exec(read('0006_action_attempt_capabilities.sql')));
  db.exec('ROLLBACK');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM step_attempts').get()?.n,1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM callback_receipts').get()?.n,1);
 }finally{db.close();}
});

test('fixed-key migration preserves historical Sessions and atomically rejects duplicates',()=>{
 const db=setup();
 try{
  for(const name of ['0006_action_attempt_capabilities.sql',
   '0007_session_executions.sql','0008_session_locator.sql'])db.exec(read(name));
  db.exec("INSERT INTO session_executions(run_id,step_id,slot,state,created_at,updated_at) VALUES('r','fixed',1,'ready',1,1)");
  db.exec(read('0009_fixed_sessions.sql'));
  assert.equal(db.prepare("SELECT fixed_key FROM session_executions WHERE step_id='fixed'").get()?.fixed_key,null);
  db.exec("UPDATE session_executions SET fixed_key='123:456' WHERE step_id='fixed'");
  assert.throws(()=>db.exec("INSERT INTO session_executions(run_id,step_id,slot,fixed_key,state,created_at,updated_at) VALUES('r','other',2,'123:456','queued',1,1)"));
  db.exec("UPDATE session_executions SET state='terminated' WHERE step_id='fixed'");
  db.exec("INSERT INTO session_executions(run_id,step_id,slot,fixed_key,state,created_at,updated_at) VALUES('r','other',2,'123:456','queued',1,1)");
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{db.close();}
});
