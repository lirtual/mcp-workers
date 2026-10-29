import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { finalizeDatabaseHyperdrive, verifyFinalizeIdentity } from './finalize-database-hyperdrive-476.mjs';
import { patchSource } from './prepare-database-hyperdrive-476.mjs';
const op='12345678-1234-1234-1234-123456789abc', sha='a'.repeat(40), version='87654321-1234-1234-1234-123456789abc';
const env={GITHUB_REPOSITORY:'lirtual/mcp-workers',GITHUB_ACTOR:'lirtual',GITHUB_EVENT_NAME:'workflow_dispatch',
  GITHUB_REF:'refs/heads/main',GITHUB_SHA:sha,GITHUB_RUN_ID:'99',GITHUB_JOB:'database-hyperdrive-finalize',
  GITHUB_WORKFLOW_REF:'lirtual/mcp-workers/.github/workflows/release.yml@refs/heads/main',
  DATABASE_RELEASE_ENVIRONMENT:'database-mcp-worker',DATABASE_EXPECTED_RELEASE_SHA:sha,
  EXPECTED_VERSION_ID:version,DATABASE_HYPERDRIVE_OPERATION_ID:op,CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),
  CLOUDFLARE_API_TOKEN:'synthetic-cf',GITHUB_TOKEN:'synthetic-job'};
const source=readFileSync(new URL('../apps/database-mcp-worker/wrangler.jsonc',import.meta.url),'utf8');
const original=JSON.parse(readFileSync(new URL('../apps/database-mcp-worker/hyperdrive-bindings.json',import.meta.url),'utf8'));
const entry={binding:'HYPERDRIVE_ISOLATED_12345678',id:'1'.repeat(32),dialect:'mysql',origin_host:'mysql.example.net',
  origin_port:3306,origin_database:'catalog',origin_user:'reader',ca_certificate_id:'12345678-1234-1234-1234-123456789abc'};
const files=patchSource(source,original,entry), manifest=JSON.parse(files['apps/database-mcp-worker/hyperdrive-bindings.json']);
function fixture(fault) {
  const db=new DatabaseSync(':memory:');let inserts=0;
  for(const name of ['0001_connections.sql','0002_transport_and_retired_ids.sql','0003_hyperdrive_operations.sql'])
    db.exec(readFileSync(new URL('../apps/database-mcp-worker/migrations/'+name,import.meta.url),'utf8'));
  db.prepare(`INSERT INTO hyperdrive_operations(operation_id,logical_id,action,expected_revision,phase,merged_sha,
    release_run_id,apply_run_id,config_id,binding_name,created_at,updated_at,expires_at,error_class)
    VALUES (?,'isolated','create',0,'running',?,99,71,?,?,1,1,?,'apply_release_pending')`)
    .run(op,sha,entry.id,entry.binding,Date.now()+600000);
  if(fault==='missing-proof')db.exec("UPDATE hyperdrive_operations SET error_class='postrelease_verified'");
  if(fault==='expired')db.exec('UPDATE hyperdrive_operations SET expires_at=1');
  if(fault==='unknown')db.exec("UPDATE hyperdrive_operations SET phase='unknown'");
  if(fault==='release-run')db.exec('UPDATE hyperdrive_operations SET release_run_id=100');
  if(fault==='retired')db.exec("INSERT INTO retired_connection_ids VALUES ('isolated',1)");
  // Simulate preexisting identity from outside the operation, without letting the fixture's
  // reservation trigger prevent injection of a conflicting legacy row.
  if(fault==='active-direct'||fault==='d1-conflict') {
    db.exec('DROP TRIGGER database_connection_respects_reservation');
    db.exec("INSERT INTO database_connections(id,dialect,transport,status,ciphertext,key_id,revision,created_at,updated_at) VALUES ('isolated','mysql','direct','active','opaque','key',1,1,1)");
  }
  if(fault==='openlist-conflict') {
    db.exec('DROP TRIGGER database_connection_respects_reservation');
    db.prepare("INSERT INTO database_connections(id,dialect,transport,status,config_id,binding_name,revision,created_at,updated_at) VALUES ('aiven_mysql_openlist','mysql','hyperdrive','active',?,'HYPERDRIVE_AIVEN_OPENLIST',7,1,1)").run(entry.id);
  }
  if(fault==='cap')for(let i=0;i<9;i++)db.prepare(`INSERT INTO database_connections(id,dialect,transport,status,ciphertext,key_id,revision,created_at,updated_at)
    VALUES (?,'mysql','direct','active','opaque','key',1,1,1)`).run('old'+i);
  const bindings=[{name:'DB',type:'d1',id:'cbfe6a05-4979-4e6a-9cc2-4f6468586e4a'},
    ...manifest.map(e=>({name:e.binding,type:'hyperdrive',id:e.id}))];
  const request=async(url,init={})=>{
    const u=new URL(url),body=init.body?JSON.parse(init.body):null;
    if(u.pathname.endsWith('/query')) {
      assert.equal(init.redirect,'manual');
      const insert=body.sql.startsWith('INSERT INTO database_connections');if(insert)inserts++;
      if(insert && fault==='insert-rejected')return new Response(null,{status:409});
      const s=db.prepare(body.sql);
      const r=body.sql.startsWith('SELECT')?{results:s.all(...body.params)}:{meta:{changes:Number(s.run(...body.params).changes)}};
      if((insert && fault==='lost-insert') || (body.sql.includes("SET phase='completed'") && fault==='lost-final') ||
        (body.sql.includes('SET published_version_id=') && fault==='lost-proof'))throw Error('lost acknowledgment');
      if(insert && fault==='ambiguous')db.exec("UPDATE hyperdrive_operations SET phase='unknown'");
      return Response.json({success:true,result:[{success:true,...r}]});
    }
    assert.equal(init.method,'GET','no external mutations');
    if(u.pathname.endsWith('/git/ref/heads/main'))return Response.json({object:{sha:fault==='main-advanced'?'b'.repeat(40):sha}});
    if(u.pathname.endsWith('/actions/runs/99'))return Response.json({id:99,head_sha:fault==='run-sha'?'b'.repeat(40):sha,head_branch:'main',
      actor:{login:fault==='run-actor'?'attacker':'lirtual'},triggering_actor:{login:'lirtual'},event:fault==='run-event'?'push':'workflow_dispatch',path:fault==='run-workflow'?'.github/workflows/ci.yml':'.github/workflows/release.yml',status:'in_progress'});
    if(u.pathname.endsWith('/jobs'))return Response.json({total_count:fault==='jobs-incomplete'?2:1,jobs:[{name:'Manual selected Worker release',
      run_id:99,head_sha:sha,status:'completed',conclusion:fault==='deploy-failed'?'failure':'success'}]});
    if(u.pathname.includes('/contents/')) {
      assert.equal(u.searchParams.get('ref'),sha);
      const path=u.pathname.split('/contents/')[1];
      return Response.json({type:'file',path,encoding:'base64',content:Buffer.from(files[path]).toString('base64')});
    }
    let result;
    if(u.pathname.endsWith('/deployments')) result={deployments:[{id:op,versions:[{version_id:fault==='wrong-version'?op:version,percentage:fault==='50-percent'?50:100}]}]};
    else if(u.pathname.endsWith('/settings'))result={bindings:fault==='binding'?bindings.slice(0,1):bindings};
    else if(u.pathname.includes('/versions/'))result={id:version,resources:{bindings:fault==='version-binding'?[]:bindings}};
    else if(u.pathname.includes('/hyperdrive/configs/')) {
      const e=manifest.find(e=>u.pathname.endsWith('/'+e.id));assert.ok(e);
      result={id:e.id,caching:{disabled:fault!=='cache'},origin:{scheme:e.dialect,host:e.origin_host,
        port:e.origin_port,database:e.origin_database,user:e.origin_user},
        mtls:{sslmode:fault==='tls'?'require':e.dialect==='mysql'?'VERIFY_IDENTITY':'verify-full',
          ca_certificate_id:fault==='ca'?'different-ca':e.ca_certificate_id}};
    } else throw Error('Unexpected request '+u.pathname);
    return Response.json({success:true,result});
  };
  return {db,request,inserts:()=>inserts};
}
test('protected identity rejects invalid actor, event, environment, SHA and version before I/O',()=>{
  verifyFinalizeIdentity(env);
  for(const [key,value] of [['GITHUB_ACTOR','attacker'],['GITHUB_EVENT_NAME','push'],
    ['DATABASE_RELEASE_ENVIRONMENT','other'],['GITHUB_JOB','deploy'],['GITHUB_RUN_ID','NaN'],
    ['DATABASE_EXPECTED_RELEASE_SHA','b'.repeat(40)],['EXPECTED_VERSION_ID','latest'],['GITHUB_WORKFLOW_REF','other']])
    assert.throws(()=>verifyFinalizeIdentity({...env,[key]:value}));
});
for(const fault of [undefined,'lost-insert','lost-final','lost-proof','cap'])test('exact release hands off disabled once: '+fault,async()=>{
  const f=fixture(fault);try {
    assert.deepEqual(await finalizeDatabaseHyperdrive(env,f.request),{operationId:op,phase:'completed',status:'disabled',revision:1});
    assert.equal(f.db.prepare('SELECT status FROM database_connections WHERE id=?').get('isolated').status,'disabled');
    assert.equal(f.db.prepare('SELECT ciphertext FROM hyperdrive_operations').get().ciphertext,null);
    await finalizeDatabaseHyperdrive(env,f.request);assert.equal(f.inserts(),1);
  }finally{f.db.close();}
});
for(const fault of ['wrong-version','50-percent','main-advanced','binding','version-binding','ca','tls','cache',
  'run-actor','run-event','run-workflow','run-sha','openlist-conflict','missing-proof','jobs-incomplete','retired','active-direct','d1-conflict','release-run','expired','unknown','deploy-failed','insert-rejected','ambiguous'])
  test('fails closed without activation or overwrites: '+fault,async()=>{
    const f=fixture(fault);try {
      await assert.rejects(finalizeDatabaseHyperdrive(env,f.request));
      assert.notEqual(f.db.prepare('SELECT phase FROM hyperdrive_operations').get().phase,'completed');
      if(fault==='active-direct'||fault==='d1-conflict')assert.equal(f.db.prepare('SELECT ciphertext FROM database_connections').get().ciphertext,'opaque');
      else if(fault==='openlist-conflict')assert.equal(f.db.prepare("SELECT revision FROM database_connections WHERE id='aiven_mysql_openlist'").get().revision,7);
      else assert.equal(f.db.prepare("SELECT COUNT(*) n FROM database_connections WHERE status='active'").get().n,0);
      if(!['insert-rejected','ambiguous'].includes(fault))assert.equal(f.inserts(),0);
      assert.ok(f.inserts()<=1);
    }finally{f.db.close();}
  });
test('reservation trigger never permits arbitrary disabled/active inserts or metadata changes',()=>{
  const f=fixture();try {
    for(const status of ['disabled','active'])assert.throws(()=>f.db.prepare(`INSERT INTO database_connections
      (id,dialect,transport,status,config_id,binding_name,revision,created_at,updated_at)
      VALUES ('isolated','mysql','hyperdrive',?,?,?,1,1,1)`).run(status,entry.id,entry.binding));
    assert.equal(f.inserts(),0);
  }finally{f.db.close();}
});

test('mismatched previously inserted disabled identity fails hard; matching partial insert recovers',async()=>{
  const f=fixture('ambiguous');try {
    await assert.rejects(finalizeDatabaseHyperdrive(env,f.request));
    f.db.exec("UPDATE hyperdrive_operations SET phase='running'");
    await finalizeDatabaseHyperdrive(env,f.request);
    assert.equal(f.inserts(),1);
    f.db.exec("UPDATE database_connections SET revision=2");
    await assert.rejects(finalizeDatabaseHyperdrive(env,f.request));
    assert.equal(f.inserts(),1);
  }finally{f.db.close();}
});
test('target metadata cannot be rewritten after handoff',async()=>{
  const f=fixture();try {
    await finalizeDatabaseHyperdrive(env,f.request);
    assert.throws(()=>f.db.exec("UPDATE database_connections SET target_metadata='{}'"));
  }finally{f.db.close();}
});
