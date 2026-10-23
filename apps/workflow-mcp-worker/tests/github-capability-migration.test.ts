import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const migration=(name:string)=>readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8');

test('D1 registered-capability migration preserves confirmed historical Attempts and callbacks',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = on');
    for(const file of ['0001_s1.sql','0002_native_complete_seen.sql',
      '0003_s3_attempt_claim.sql','0004_s3_callback_receipts.sql'])db.exec(migration(file));
    db.prepare('INSERT INTO workflows(id,name,draft,created_at,updated_at) VALUES (?,?,?,?,?)')
      .run('w','Historical record','{}',1,1);
    db.prepare('INSERT INTO workflow_versions(id,workflow_id,digest,plan,created_at) VALUES (?,?,?,?,?)')
      .run('v','w','digest','{}',1);
    db.prepare('INSERT INTO runs(id,workflow_id,version_id,instance_id,request_digest,inputs,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run('r','w','v','instance','digest','{}',1,1);
    db.prepare('INSERT INTO step_attempts(attempt_id,run_id,step_id,capability_id,dispatch_id,state,repository,repository_id,workflow_ref,ref,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('old','r','step','heavy.github.echo','d-old','succeeded','lirtual/mcp-workers','1414936394','ref','refs/heads/main',1,1);
    db.prepare('INSERT INTO callback_receipts(callback_id,attempt_id,outcome,result_json,created_at) VALUES (?,?,?,?,?)')
      .run('cb-old','old','succeeded','{"echo":"ok"}',1);
    // D1 applies migration SQL in a transaction with deferred foreign-key
    // checks. Reproduce this even with an existing referencing callback.
    db.exec('BEGIN;\n'+migration('0005_github_workflow_check.sql')+'\nCOMMIT;');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.equal(db.prepare('SELECT capability_id FROM step_attempts WHERE attempt_id=?').get('old')?.capability_id,'heavy.github.echo');
    assert.equal(db.prepare('SELECT attempt_id FROM callback_receipts WHERE callback_id=?').get('cb-old')?.attempt_id,'old');
    db.prepare('INSERT INTO step_attempts(attempt_id,run_id,step_id,capability_id,dispatch_id,state,repository,repository_id,workflow_ref,ref,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('new','r','check','github.workflow.check','d-new','created','lirtual/mcp-workers','1414936394','ref','refs/heads/main',2,2);
    assert.throws(()=>db.prepare('INSERT INTO step_attempts(attempt_id,run_id,step_id,capability_id,dispatch_id,state,repository,repository_id,workflow_ref,ref,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('bad','r','bad','shell.run','d-bad','created','lirtual/mcp-workers','1414936394','ref','refs/heads/main',2,2),/CHECK constraint failed/);
  }finally {db.close();}
});

test('registered GitHub action migration keeps old Attempts and still rejects shell',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = on');
    for(const file of ['0001_s1.sql','0002_native_complete_seen.sql',
      '0003_s3_attempt_claim.sql','0004_s3_callback_receipts.sql','0005_github_workflow_check.sql'])
      db.exec(migration(file));
    db.prepare('INSERT INTO workflows(id,name,draft,created_at,updated_at) VALUES (?,?,?,?,?)')
      .run('w','Historical record','{}',1,1);
    db.prepare('INSERT INTO workflow_versions(id,workflow_id,digest,plan,created_at) VALUES (?,?,?,?,?)')
      .run('v','w','digest','{}',1);
    db.prepare('INSERT INTO runs(id,workflow_id,version_id,instance_id,request_digest,inputs,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run('r','w','v','instance','digest','{}',1,1);
    db.prepare('INSERT INTO step_attempts(attempt_id,run_id,step_id,capability_id,dispatch_id,state,repository,repository_id,workflow_ref,ref,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('check','r','step','github.workflow.check','d-check','confirmed','lirtual/mcp-workers','1414936394','ref','refs/heads/main',1,1);
    db.exec('BEGIN;\n'+migration('0006_github_registered_action.sql')+'\nCOMMIT;');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.equal(db.prepare('SELECT capability_id FROM step_attempts WHERE attempt_id=?').get('check')?.capability_id,'github.workflow.check');
    db.prepare('INSERT INTO step_attempts(attempt_id,run_id,step_id,capability_id,dispatch_id,state,repository,repository_id,workflow_ref,ref,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('listed','r','act','github.action.registered','d-listed','created','lirtual/mcp-workers','1414936394','ref','refs/heads/main',2,2);
    assert.throws(()=>db.prepare('INSERT INTO step_attempts(attempt_id,run_id,step_id,capability_id,dispatch_id,state,repository,repository_id,workflow_ref,ref,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('bad','r','bad','shell.run','d-bad','created','lirtual/mcp-workers','1414936394','ref','refs/heads/main',3,3),/CHECK constraint failed/);
  }finally {db.close();}
});
