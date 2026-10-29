import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const app=fileURLToPath(new URL('../',import.meta.url));
const migrations=join(app,'migrations');
const syntheticId='00000000-0000-4000-8000-000000000476';
function wrangler(root, ...args){
  return execFileSync('pnpm',['exec','wrangler','d1',...args,'--config',join(root,'wrangler.json'),
    '--local','--persist-to',join(root,'state')],{
    cwd:app,encoding:'utf8',timeout:45000,
    env:{...process.env, CI:'true', CLOUDFLARE_API_TOKEN:'',CLOUDFLARE_ACCOUNT_ID:''},
    stdio:['ignore','pipe','pipe']
  });
}
function execute(root,sql){
  const raw=wrangler(root,'execute','DB','--command',sql,'--json');
  const result=JSON.parse(raw);
  assert.equal(result.length,1);
  assert.equal(result[0].success,true);
  return result[0].results;
}
function rejectsSql(root,sql){
  assert.throws(()=>execute(root,sql),error=>{
    assert.equal(error.status,1);
    return true;
  });
}

test('Spec #476 Wrangler local D1 migration and admission/disable/retire safety', {timeout:120000},()=>{
  const root=mkdtempSync(join(tmpdir(),'spec476-d1-e2e-'));
  try{
    mkdirSync(join(root,'migrations'));
    mkdirSync(join(root,'state'));
    mkdirSync(join(root,'src'));
    cpSync(migrations,join(root,'migrations'),{recursive:true});
    writeFileSync(join(root,'src/index.js'),'export default {fetch:()=>new Response("synthetic")};\n');
    writeFileSync(join(root,'wrangler.json'),JSON.stringify({
      name:'spec476-ephemeral',main:'src/index.js',compatibility_date:'2026-09-12',
      d1_databases:[{binding:'DB',database_name:'spec476-ephemeral',database_id:syntheticId,
        migrations_dir:'migrations'}]
    }));
    const migrated=wrangler(root,'migrations','apply','DB');
    for(const name of ['0001_connections.sql','0002_transport_and_retired_ids.sql','0003_hyperdrive_operations.sql'])
      assert.ok(migrated.includes(name+' ') || migrated.includes(name+'│'));
    const applied=execute(root,'SELECT name FROM d1_migrations ORDER BY id');
    assert.deepEqual(applied.map(r=>r.name),[
      '0001_connections.sql','0002_transport_and_retired_ids.sql','0003_hyperdrive_operations.sql'
    ]);
    assert.ok(execute(root,'PRAGMA table_info(database_connections)').some(r=>r.name==='in_flight_count'));
    const triggers=execute(root,"SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'database_connection_blocks_inflight_%' ORDER BY name");
    assert.equal(triggers.length,2);
    // All identifiers and resources in this test are synthetic and isolated.
    execute(root,`INSERT INTO database_connections
      (id,dialect,transport,status,config_id,binding_name,revision,created_at,updated_at)
      VALUES ('ephemeral','mysql','hyperdrive','active','12345678-aaaa-4abc-8000-aaaaaaaaaaaa','HYPERDRIVE_TEST',3,1,1)`);
    const claim="UPDATE database_connections SET in_flight_count=in_flight_count+1 WHERE id='ephemeral' AND revision=3 AND transport='hyperdrive' AND status='active'";
    assert.equal(execute(root,claim).length,0);
    assert.equal(execute(root,"SELECT in_flight_count FROM database_connections WHERE id='ephemeral'")[0].in_flight_count,1);
    execute(root,"UPDATE database_connections SET status='disabled',revision=revision+1 WHERE id='ephemeral'");
    execute(root,claim);
    assert.equal(execute(root,"SELECT in_flight_count FROM database_connections WHERE id='ephemeral'")[0].in_flight_count,1);
    rejectsSql(root,"DELETE FROM database_connections WHERE id='ephemeral'");
    rejectsSql(root,"UPDATE database_connections SET binding_name='HYPERDRIVE_CHANGED' WHERE id='ephemeral'");
    execute(root,"UPDATE database_connections SET in_flight_count=in_flight_count-1 WHERE id='ephemeral' AND in_flight_count>0");
    assert.equal(execute(root,"SELECT in_flight_count FROM database_connections WHERE id='ephemeral'")[0].in_flight_count,0);
    execute(root,"DELETE FROM database_connections WHERE id='ephemeral' AND revision=4 AND status='disabled' AND in_flight_count=0");
    assert.equal(execute(root,"SELECT id FROM retired_connection_ids WHERE id='ephemeral'").length,1);
    rejectsSql(root,`INSERT INTO database_connections
      (id,dialect,transport,status,config_id,binding_name,revision,created_at,updated_at)
      VALUES ('ephemeral','mysql','hyperdrive','disabled','12345678-aaaa-4abc-8000-aaaaaaaaaaaa','HYPERDRIVE_TEST',1,1,1)`);
  }finally{rmSync(root,{recursive:true,force:true});}
});
