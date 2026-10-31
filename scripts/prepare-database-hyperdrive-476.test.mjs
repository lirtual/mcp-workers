import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { verifyGithubPrPreflight, verifyPrepareIdentity, patchSource, verifyPreparedPullRequest, verifySpec476MainMergeWindow } from './prepare-database-hyperdrive-476.mjs';

const sha='a'.repeat(40);
const env={
  GITHUB_REPOSITORY:'lirtual/mcp-workers',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_RUN_ID:'42',
  GITHUB_ACTOR:'lirtual',GITHUB_REF:'refs/heads/main',GITHUB_SHA:sha,
  DATABASE_HYPERDRIVE_OPERATION_ID:'12345678-1234-1234-1234-123456789abc',
  CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'secret-test-cloud',
  GITHUB_TOKEN:'secret-test-github',DATABASE_GITHUB_ACTIONS_TOKEN:'secret-owner',
  DATABASE_ENCRYPTION_KEY:'test-key',DATABASE_KEY_ID:'key1'
};
test('temporary main update restriction permits only the exact reviewed GitHub Actions App and main branch',()=>{
  const summary={id:501,name:'spec476-main-merge-window',target:'branch',enforcement:'active'};
  const detail={...summary,source_type:'Repository',source:'lirtual/mcp-workers',
    conditions:{ref_name:{include:['refs/heads/main'],exclude:[]}},
    bypass_actors:[{actor_type:'Integration',actor_id:15368,bypass_mode:'always'}],
    rules:[{type:'update',parameters:{update_allows_fetch_and_merge:false}}]};
  assert.equal(verifySpec476MainMergeWindow(summary,detail),true);
  for(const patch of [
    {source_type:'Organization'}, {enforcement:'disabled'},
    {conditions:{ref_name:{include:['~ALL'],exclude:[]}}},
    {bypass_actors:[{actor_type:'RepositoryRole',actor_id:5,bypass_mode:'always'}]},
    {rules:[{type:'update',parameters:{update_allows_fetch_and_merge:true}}]},
    {rules:[...detail.rules,{type:'deletion'}]},
  ]) assert.equal(verifySpec476MainMergeWindow(summary,{...detail,...patch}),false);
});
test('only exact Owner/main operation with scoped credentials may prepare',()=>{
  assert.equal(verifyPrepareIdentity(env),true);
  for (const [field,bad] of [['GITHUB_ACTOR','attacker'],['GITHUB_REF','refs/heads/feat'],
    ['GITHUB_REPOSITORY','lirtual/fork'],['GITHUB_EVENT_NAME','push'],['GITHUB_RUN_ID','0'],
    ['DATABASE_HYPERDRIVE_OPERATION_ID','../nonsense'],['GITHUB_TOKEN',undefined],
    ['DATABASE_GITHUB_ACTIONS_TOKEN',undefined],
    ['DATABASE_KEY_ID','bad key']]) {
    assert.throws(()=>verifyPrepareIdentity({...env,[field]:bad}), /preparation blocked/i);
  }
});
test('unknown branch policy blocks before any Cloudflare resource write',async()=>{
  let requests=0;
  await assert.rejects(verifyGithubPrPreflight({sourceSha:sha,token:'dummy',
    request:async(url)=>{
      requests++;
      assert.match(String(url),/branches\/main$/);
      return new Response(null, {status: 403});
    }}),/preparation blocked/i);
  assert.equal(requests,1);
});
test('even with PR setting, branch protection is not silently bypassed',async()=>{
  const calls=[];
  await assert.rejects(verifyGithubPrPreflight({sourceSha:sha,token:'dummy',
    request:async(url)=>{
      calls.push(String(url));
      if(String(url).endsWith('/branches/main'))return Response.json({name:'main',protected:true});
      if(String(url).endsWith('branches/main/protection'))return Response.json({required_status_checks:{}});
      if(String(url).includes('/rulesets'))return Response.json([]);
      throw Error('Unexpected upstream');
    }}),/preparation blocked/i);
  assert.equal(calls.length,3);
});
test('source changes are exactly the fixed binding and reviewed manifest; never secrets',()=>{
  const input=readFileSync(new URL('../apps/database-mcp-worker/wrangler.jsonc',import.meta.url),'utf8');
  const manifest=JSON.parse(readFileSync(new URL('../apps/database-mcp-worker/hyperdrive-bindings.json',import.meta.url),'utf8'));
  const entry={binding:'HYPERDRIVE_NEW_12345678',id:'1234567890abcdef1234567890abcdef',dialect:'mysql',
    origin_host:'host.example.net',origin_port:3306,origin_database:'catalog',
    origin_user:'reader',ca_certificate_id:'12345678-1234-1234-1234-123456789abc'};
  const files=patchSource(input,manifest,entry);
  assert.deepEqual(Object.keys(files).sort(),[
    'apps/database-mcp-worker/hyperdrive-bindings.json',
    'apps/database-mcp-worker/wrangler.jsonc'
  ]);
  const config=JSON.parse(files['apps/database-mcp-worker/wrangler.jsonc']);
  assert.equal(config.hyperdrive.length,manifest.length+1);
  assert.deepEqual(config.hyperdrive.slice(0,-1),JSON.parse(input).hyperdrive);
  assert.equal(config.hyperdrive.at(-1).binding,entry.binding);
  assert.deepEqual(JSON.parse(files['apps/database-mcp-worker/hyperdrive-bindings.json']),[...manifest,entry]);
  assert.ok(!JSON.stringify(files).includes('very-secret-password'));
});

test('only explicit unprotected main with eligible existing CI and exact SHA may prepare', async () => {
  const ci=readFileSync(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8');
  for(const fault of [null,'403','rules','sha','ci-inactive','ci-content','ci-unknown']) {
    const request=async(url)=>{
      if(String(url).endsWith('/branches/main'))return fault==='403'
        ? new Response(null,{status:403}) : Response.json({name:'main',protected:false});
      if(String(url).includes('/rulesets')) return Response.json(fault==='rules'?[{id:1}]:[]);
      if(String(url).endsWith('/git/ref/heads/main')) return Response.json({object:{sha:fault==='sha'?'f'.repeat(40):sha}});
      if(String(url).endsWith('/actions/workflows/ci.yml')) return Response.json({id:1,path:'.github/workflows/ci.yml',state:fault==='ci-inactive'?'disabled_manually':'active'});
      if(String(url).includes('/contents/.github/workflows/ci.yml?ref='+sha)) {
        if(fault==='ci-unknown')return new Response(null,{status:403});
        return Response.json({path:'.github/workflows/ci.yml',type:'file',encoding:'base64',
          content:Buffer.from(fault==='ci-content'?'unrelated workflow':ci).toString('base64')});
      }
      throw Error('unexpected request');
    };
    const action=()=>verifyGithubPrPreflight({sourceSha:sha,token:'dummy',request});
    if(fault===null) assert.deepEqual(await action(),{unprotected:true});
    else await assert.rejects(action(), /preparation blocked/i);
  }
});

test('a protected policy must identify the existing CI workflow before preparation',async()=>{
  const calls=[];
  assert.deepEqual(await verifyGithubPrPreflight({token:'dummy',sourceSha:sha,request:async(url)=>{
    calls.push(String(url));
    if(String(url).endsWith('/branches/main'))return Response.json({name:'main',protected:true});
    if(String(url).endsWith('/branches/main/protection'))return Response.json({required_status_checks:{strict:true,contexts:['Required checks gate']}});
    if(String(url).includes('/rulesets'))return Response.json([]);
    if(String(url).endsWith('/actions/workflows/ci.yml'))return Response.json({id:1,path:'.github/workflows/ci.yml',state:'active'});
    if(String(url).endsWith('/git/ref/heads/main'))return Response.json({object:{sha}});
    throw Error('unexpected request');
  }}),{unprotected:false});
  assert.equal(calls.length,5);
});


test('PR source verification rejects extra files, different parent, base advance and secret blob substitution',async()=>{
  const operationId=env.DATABASE_HYPERDRIVE_OPERATION_ID,headSha='b'.repeat(40),blobSha='c'.repeat(40);
  const files={'apps/database-mcp-worker/wrangler.jsonc':'safe binding',
    'apps/database-mcp-worker/hyperdrive-bindings.json':'safe provenance'};
  const good={number:3,state:'open',changed_files:2,commits:1,
    head:{sha:headSha,ref:'db476-'+operationId,repo:{full_name:'lirtual/mcp-workers'}},
    base:{sha,ref:'main',repo:{full_name:'lirtual/mcp-workers'}}};
  for(const fault of [null,'extra','parent','base','secret']) {
    const github=async(path)=>{
      if(path==='/pulls/3')return fault==='base'?{...good,base:{...good.base,sha:'d'.repeat(40)}}:good;
      if(path==='/git/commits/'+headSha)return {sha:headSha,parents:[{sha:fault==='parent'?'e'.repeat(40):sha}]};
      if(path.includes('/files?'))return Object.keys(files).concat(fault==='extra'?['.github/workflows/ci.yml']:[])
        .map(filename=>({filename,status:'modified',sha:blobSha}));
      if(path==='/git/blobs/'+blobSha) {
        // The two reads correspond to the two distinct generated source entries.
        const content=Object.values(files)[reads++];
        return {sha:blobSha,encoding:'base64',content:Buffer.from(fault==='secret'?'injected password':content).toString('base64')};
      }
      throw Error('unexpected read');
    };
    let reads=0;
    const inspect=()=>verifyPreparedPullRequest({github,operationId,baseSha:sha,headSha,prNumber:3,files});
    if(fault===null)assert.equal(await inspect(),true);
    else await assert.rejects(inspect(),/preparation blocked/);
  }
});

test('preparation entrypoint performs zero Cloudflare calls when preflight is unreadable',async()=>{
  const {prepareDatabaseHyperdrive}=await import('./prepare-database-hyperdrive-476.mjs');
  let calls=0;
  await assert.rejects(prepareDatabaseHyperdrive(env,async(url)=>{
    calls++;
    assert.match(String(url),/^https:\/\/api.github.com\//);
    return new Response(null,{status:403});
  }),error=>error.reason==='github_protection_unavailable');
  assert.equal(calls,1);
});

// Exercise the existing Actions entrypoint, real SQLite and Runner decryption.
// Every upstream request below is synthetic; no real origin is contacted.
test('PR confirmation renews a nonsecret seven-day review window but never the encrypted intake', async()=>{
  const source=readFileSync(new URL('./prepare-database-hyperdrive-476.mjs',import.meta.url),'utf8');
  assert.match(source,/const reviewExpiresAt = reviewedAt \+ 7 \* 24 \* 60 \* 60_000/);
  assert.match(source,/SET phase='awaiting_confirmation',ciphertext=NULL,key_id=NULL/);
  assert.match(source,/updated_at=\?,expires_at=\?,error_class='github_pr_ci_pending'/);
  assert.match(source,/AND phase='running' AND expected_source_sha=\? AND expires_at>\?/);
});
for (const mode of ['lost-protected','lost-unprotected','success-protected','success-unprotected','ca-success-unprotected','ca-lost-unprotected','ca-existing-match-unprotected','ca-existing-different-unprotected','ca-existing-ambiguous-unprotected','ca-existing-unreadable-unprotected','ca-duplicate-unprotected','ca-wrong-pem-unprotected','ca-permission-unprotected','ca-replacement-unprotected','ca-replacement-drift-unprotected','ca-replacement-upstream-drift-unprotected','ca-replacement-upstream-ca-drift-unprotected','ca-replacement-upstream-tls-drift-unprotected','ca-replacement-upstream-unreadable-unprotected'])
test('preparation preserves policy and resource receipt safety: '+mode,async()=>{
  const {DatabaseSync}=await import('node:sqlite');
  const {createCipheriv}=await import('node:crypto');
  const {prepareDatabaseHyperdrive}=await import('./prepare-database-hyperdrive-476.mjs');
  const db=new DatabaseSync(':memory:');
  for(const name of ['0001_connections.sql','0002_transport_and_retired_ids.sql',
    '0003_hyperdrive_operations.sql']) {
    db.exec(readFileSync(new URL('../apps/database-mcp-worker/migrations/'+name,import.meta.url),'utf8'));
  }
  const key=Buffer.alloc(32,7),iv=Buffer.alloc(12,8),operationId=env.DATABASE_HYPERDRIVE_OPERATION_ID;
  const candidate={id:'isolated',dialect:'mysql',host:'mysql.example.net',port:'3306',
    database:'catalog',user:'reader',password:'synthetic-password',
    ...(mode.startsWith('ca-') ? {caPem:'-----BEGIN CERTIFICATE-----\nQUJDRA==\n-----END CERTIFICATE-----'} :
      {caCertificateId:'b0e4a5d3-1665-4e3c-a0a0-28f9a2b9b1c0'})};
  if(mode.startsWith('ca-replacement-')){
    candidate.caReplaces='old_ref';
    const prior={binding:'HYPERDRIVE_OLD',id:'e'.repeat(32),dialect:'mysql',
      origin_host:mode==='ca-replacement-drift-unprotected'?'wrong.example.net':'mysql.example.net',
      origin_port:3306,origin_database:'catalog',origin_user:'reader',
      ca_certificate_id:'old-ca-123456789'};
    db.prepare(`INSERT INTO database_connections
      (id,dialect,transport,status,revision,config_id,binding_name,target_metadata,created_at,updated_at)
      VALUES ('old_ref','mysql','hyperdrive','active',3,?,?,?,1,1)`)
      .run(prior.id,prior.binding,JSON.stringify(prior));
  }
  const cipher=createCipheriv('aes-256-gcm',key,iv);
  cipher.setAAD(Buffer.from('database-mcp:hyperdrive-operation:v1:'+operationId+':create:isolated:0'));
  const encrypted=Buffer.concat([cipher.update(JSON.stringify(candidate)),cipher.final(),cipher.getAuthTag()]);
  db.prepare(`INSERT INTO hyperdrive_operations
    (operation_id,logical_id,action,expected_revision,phase,ciphertext,key_id,created_at,updated_at,expires_at)
    VALUES (?,?,'create',0,'running',?,'key1',1,1,?)`)
    .run(operationId,candidate.id,iv.toString('base64')+'.'+encrypted.toString('base64'),Date.now()+600000);
  let creates=0, caUploads=0, caWritten=false;
  const isCa=mode.startsWith('ca-');
  const unprotected=mode.endsWith('-unprotected'), success=mode.startsWith('success-') || mode.startsWith('ca-success') || mode==='ca-replacement-unprotected' ||
    ['ca-existing-match-unprotected','ca-existing-different-unprotected'].includes(mode);
  const configId='1'.repeat(32), head='b'.repeat(40), blobs=new Map();
  let createdConfig;
  const request=async(url,init={})=>{
    const path=new URL(url).pathname;
    if(path.endsWith('/branches/main'))return Response.json({name:'main',protected:!unprotected});
    if(path.endsWith('/branches/main/protection'))return Response.json({required_status_checks:{strict:true,contexts:['Required checks gate']}});
    if(path.endsWith('/rulesets'))return Response.json([]);
    if(path.endsWith('/actions/workflows/ci.yml'))return Response.json({id:1,path:'.github/workflows/ci.yml',state:'active'});
    if(path.endsWith('/git/ref/heads/main'))return Response.json({object:{sha}});
    if(path.endsWith('/contents/.github/workflows/ci.yml'))return Response.json({path:'.github/workflows/ci.yml',
      type:'file',encoding:'base64',content:Buffer.from(readFileSync(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8')).toString('base64')});
    if(path.includes('/git/') || path.includes('/pulls')) {
      const body=init.body?JSON.parse(init.body):undefined;
      assert.ok(!JSON.stringify(body??'').includes(candidate.password));
      if(path.endsWith('/git/commits/'+sha))return Response.json({sha,tree:{sha:'c'.repeat(40)}});
      if(path.endsWith('/git/commits/'+head))return Response.json({sha:head,parents:[{sha}]});
      if(path.endsWith('/git/blobs')&&init.method==='POST') {
        const id=String(blobs.size+2).repeat(40);blobs.set(id,body.content);
        return Response.json({sha:id});
      }
      if(path.includes('/git/blobs/')) {
        const id=path.split('/').at(-1);return Response.json({sha:id,encoding:'base64',content:blobs.get(id)});
      }
      if(path.endsWith('/git/trees'))return Response.json({sha:'d'.repeat(40)});
      if(path.endsWith('/git/commits'))return Response.json({sha:head});
      if(path.endsWith('/git/refs'))return Response.json({});
      if(path.endsWith('/pulls')&&init.method==='POST') {
        assert.equal(body.draft,!unprotected);
        return Response.json({number:3});
      }
      if(path.endsWith('/pulls/3'))return Response.json({number:3,state:'open',changed_files:2,commits:1,
        head:{sha:head,ref:'db476-'+operationId,repo:{full_name:'lirtual/mcp-workers'}},
        base:{sha,ref:'main',repo:{full_name:'lirtual/mcp-workers'}}});
      if(path.endsWith('/pulls/3/files'))return Response.json([...blobs.keys()].map((id,index)=>({
        filename:['apps/database-mcp-worker/wrangler.jsonc','apps/database-mcp-worker/hyperdrive-bindings.json'][index],
        status:'modified',sha:id})));
    }
    if(path.endsWith('/query')) {
      const {sql,params}=JSON.parse(init.body),statement=db.prepare(sql);
      const result=sql.startsWith('SELECT')?{results:statement.all(...params)}:
        {meta:{changes:Number(statement.run(...params).changes)}};
      return Response.json({success:true,result:[{success:true,...result}]});
    }
    if(path.endsWith('/mtls_certificates') && init.method==='GET' && mode==='ca-permission-unprotected')return new Response(null,{status:403});
    if(path.endsWith('/mtls_certificates') && init.method==='GET'){
      const existing=mode.startsWith('ca-existing-')?
        [{id:'8'.repeat(36),name:'preexisting-account-ca',ca:true,type:'custom'},
          ...(mode==='ca-existing-ambiguous-unprotected'?
            [{id:'9'.repeat(36),name:'another-installed-ca',ca:true,type:'custom'}]:[])]:[];
      const current=mode==='ca-duplicate-unprotected'?[{id:'6'.repeat(36),name:'db476-'+operationId+'-ca',ca:true},
        {id:'7'.repeat(36),name:'db476-'+operationId+'-ca',ca:true}]:
        caWritten?[{id:'6'.repeat(36),name:'db476-'+operationId+'-ca',ca:true,certificates:candidate.caPem}]:[];
      return Response.json({success:true,result:[...existing,...current],
        result_info:{total_pages:1,total_count:existing.length+current.length}});
    }
    if(path.endsWith('/mtls_certificates/'+'8'.repeat(36)) ||
       path.endsWith('/mtls_certificates/'+'9'.repeat(36))){
      if(mode==='ca-existing-unreadable-unprotected')return new Response(null,{status:403});
      return Response.json({success:true,result:{id:path.split('/').at(-1),ca:true,
        type:'custom',certificates:mode==='ca-existing-different-unprotected'?
          '-----BEGIN CERTIFICATE-----\nRGlmZmVyZW50\n-----END CERTIFICATE-----':candidate.caPem}});
    }
    if(path.endsWith('/mtls_certificates') && init.method==='POST') {
      caUploads++;
      const body=JSON.parse(init.body);
      assert.equal(body.ca,true);
      assert.equal(body.certificates,candidate.caPem);
      assert.equal(body.name,'db476-'+operationId+'-ca');
      caWritten=true;
      if(mode.startsWith('ca-lost'))throw Error('synthetic CA response lost');
      return Response.json({success:true,result:{id:'6'.repeat(36),name:body.name,ca:true,certificates:body.certificates}});
    }
    if(path.endsWith('/mtls_certificates/'+'6'.repeat(36)))return Response.json({success:true,result:{id:'6'.repeat(36),name:'db476-'+operationId+'-ca',ca:true,certificates:mode==='ca-wrong-pem-unprotected'?'mismatched':candidate.caPem}});
    if(path.endsWith('/mtls_certificates/'+candidate.caCertificateId))return Response.json({success:true,result:{id:candidate.caCertificateId,ca:true}});
    if(path.endsWith('/hyperdrive/configs/'+'e'.repeat(32))) {
      if(mode==='ca-replacement-upstream-unreadable-unprotected')return new Response(null,{status:403});
      return Response.json({success:true,result:{id:'e'.repeat(32),origin:{scheme:'mysql',
        host:mode==='ca-replacement-upstream-drift-unprotected'?'changed.example.net':'mysql.example.net',
        port:3306,database:'catalog',user:'reader'},caching:{disabled:true},
        mtls:{sslmode:mode==='ca-replacement-upstream-tls-drift-unprotected'?'require':'VERIFY_IDENTITY',
          ca_certificate_id:mode==='ca-replacement-upstream-ca-drift-unprotected'?'different-ca-123456789':'old-ca-123456789'}}});
    }
    if(path.endsWith('/hyperdrive/configs') && init.method==='GET')return Response.json({success:true,result:[]});
    if(path.endsWith('/hyperdrive/configs') && init.method==='POST') {
      creates++;
      const body=JSON.parse(init.body);
      assert.equal(body.mtls.sslmode,'VERIFY_IDENTITY');
      assert.equal(body.caching.disabled,true);
      if(!success && !isCa)throw Error('synthetic lost acknowledgment');
      createdConfig={id:configId,...body};
      return Response.json({success:true,result:createdConfig});
    }
    if(path.endsWith('/hyperdrive/configs/'+configId))return Response.json({success:true,result:createdConfig});
    throw Error('Unexpected synthetic upstream');
  };
  try {
    const runnerEnv={...env,DATABASE_ENCRYPTION_KEY:key.toString('base64'),GITHUB_RUN_ID:'42'};
    if(mode==='ca-replacement-drift-unprotected'){
      await assert.rejects(prepareDatabaseHyperdrive(runnerEnv,request),
        error=>error.reason==='ca_replacement_target_changed');
      assert.equal(creates,0);
      assert.equal(caUploads,0);
      assert.deepEqual({...db.prepare('SELECT status,revision FROM database_connections WHERE id=?').get('old_ref')},
        {status:'active',revision:3});
      return;
    }
    if(['ca-replacement-upstream-drift-unprotected','ca-replacement-upstream-ca-drift-unprotected','ca-replacement-upstream-tls-drift-unprotected','ca-replacement-upstream-unreadable-unprotected'].includes(mode)) {
      await assert.rejects(prepareDatabaseHyperdrive(runnerEnv,request),
        error=>error.reason===(mode==='ca-replacement-upstream-unreadable-unprotected' ?
          'ca_replacement_config_unavailable' : 'ca_replacement_target_changed'));
      assert.equal(creates,0);
      assert.equal(caUploads,0);
      assert.deepEqual({...db.prepare('SELECT status,revision FROM database_connections WHERE id=?').get('old_ref')},
        {status:'active',revision:3});
      return;
    }
    if(['ca-duplicate-unprotected','ca-wrong-pem-unprotected','ca-permission-unprotected',
      'ca-existing-ambiguous-unprotected','ca-existing-unreadable-unprotected'].includes(mode)) {
      await assert.rejects(prepareDatabaseHyperdrive(runnerEnv,request),error=>
        error.reason===(['ca-duplicate-unprotected','ca-existing-ambiguous-unprotected'].includes(mode)?
          'ca_inventory_ambiguous':
          ['ca-permission-unprotected','ca-existing-unreadable-unprotected'].includes(mode)?
            'ca_permission_denied':'ca_content_mismatch'));
      assert.equal(creates,0);
      assert.equal(caUploads,mode==='ca-wrong-pem-unprotected'?1:0);
      if(mode==='ca-permission-unprotected') {
        assert.equal(db.prepare('SELECT error_class FROM hyperdrive_operations').get().error_class,
          'ca_permission_denied');
      }
      return;
    }
    if(success) {
      const result=await prepareDatabaseHyperdrive(runnerEnv,request);
      assert.equal(result.phase,'awaiting_confirmation');
      assert.equal(creates,1);
      if(mode==='ca-replacement-unprotected'){
        assert.deepEqual({...db.prepare('SELECT status,revision FROM database_connections WHERE id=?').get('old_ref')},
          {status:'active',revision:3});
      }
      if(isCa){
        const reused=mode==='ca-existing-match-unprotected';
        assert.equal(caUploads,reused?0:1);
        assert.equal(createdConfig.mtls.ca_certificate_id,reused?'8'.repeat(36):'6'.repeat(36));
        if(reused){
          assert.deepEqual({...db.prepare('SELECT ca_certificate_id,ca_write_started_at FROM hyperdrive_operations').get()},
            {ca_certificate_id:'8'.repeat(36),ca_write_started_at:null});
        }
      }
      assert.deepEqual({...db.prepare('SELECT phase,pr_number,head_sha,ciphertext,key_id FROM hyperdrive_operations').get()},
        {phase:'awaiting_confirmation',pr_number:3,head_sha:head,ciphertext:null,key_id:null});
      return;
    }
    if(isCa){
      await assert.rejects(prepareDatabaseHyperdrive(runnerEnv,request),error=>error.reason==='cloudflare_outcome_unknown');
      assert.equal(caUploads,1);
      assert.equal(creates,0);
      const repaired=await prepareDatabaseHyperdrive(runnerEnv,request);
      assert.equal(repaired.phase,'awaiting_confirmation');
      assert.equal(creates,1);
      assert.equal(caUploads,1);
      return;
    }
    await assert.rejects(prepareDatabaseHyperdrive(runnerEnv,request),error=>error.reason==='cloudflare_outcome_unknown');
    assert.equal(creates,1);
    const row=db.prepare('SELECT phase,error_class,resource_write_started_at FROM hyperdrive_operations').get();
    assert.equal(row.phase,'unknown');
    assert.equal(row.error_class,'preparation_requires_reconciliation');
    assert.ok(row.resource_write_started_at>0);
    await assert.rejects(prepareDatabaseHyperdrive(runnerEnv,request),error=>error.reason==='cloudflare_outcome_requires_reconciliation');
    assert.equal(creates,1);
  } finally {db.close();}
});


test('retired Aiven test provisioning entrypoints cannot return through CI',async()=>{
  const {existsSync}=await import('node:fs');
  assert.equal(existsSync(new URL('./database-aiven-hyperdrive-prepare-344.mjs',import.meta.url)),false);
  const ci=readFileSync(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8');
  const release=readFileSync(new URL('../.github/workflows/release.yml',import.meta.url),'utf8');
  assert.doesNotMatch(ci+release,/database-aiven-hyperdrive-prepare-344/);
  assert.match(ci,/retire-database-hyperdrive.test.mjs/);
});

test('failed unbound Apply can restage once without credentials or rewriting its audit',async()=>{
  const {DatabaseSync}=await import('node:sqlite');
  const {readConfiguration}=await import('./manual-worker-release.mjs');
  const {recoverFailedHyperdriveCandidate}=await import('./prepare-database-hyperdrive-476.mjs');
  for(const fault of ['success','drift','config','pr','post-reserve']){
    const db=new DatabaseSync(':memory:');
    try{
      for(const file of ['0001_connections.sql','0002_transport_and_retired_ids.sql','0003_hyperdrive_operations.sql'])
        db.exec(readFileSync(new URL('../apps/database-mcp-worker/migrations/'+file,import.meta.url),'utf8'));
      const oldId=env.DATABASE_HYPERDRIVE_OPERATION_ID, oldBase=sha, nowSha='9'.repeat(40), oldHead='b'.repeat(40);
      const configId='1'.repeat(32), caId='12345678-1234-1234-1234-123456789abc';
      const oldBinding='HYPERDRIVE_ISOLATED_12345678';
      db.prepare("INSERT INTO hyperdrive_operations (operation_id,logical_id,action,expected_revision,phase,error_class,expected_source_sha,head_sha,config_id,binding_name,ca_certificate_id,pr_number,prepare_run_id,ci_run_id,apply_run_id,resource_write_started_at,created_at,updated_at,expires_at) VALUES (?,'isolated','create',0,'failed','apply_merge_denied',?,?,?,?,?,3,42,98,71,100,1,1,?)")
        .run(oldId,oldBase,oldHead,configId,oldBinding,caId,Date.now()+600000);
      const row={...db.prepare('SELECT * FROM hyperdrive_operations WHERE operation_id=?').get(oldId)};
      const before=JSON.stringify(row);
      const sourceText=readFileSync(new URL('../apps/database-mcp-worker/wrangler.jsonc',import.meta.url),'utf8');
      const manifest=JSON.parse(readFileSync(new URL('../apps/database-mcp-worker/hyperdrive-bindings.json',import.meta.url),'utf8'));
      const source=readConfiguration('database-mcp-worker',sourceText);
      const entry={binding:oldBinding,id:configId,dialect:'mysql',origin_host:'mysql.example.net',origin_port:3306,
        origin_database:'catalog',origin_user:'reader',ca_certificate_id:caId};
      const oldFiles=patchSource(sourceText,manifest,entry);
      const oldBlobs=new Map(Object.entries(oldFiles).map(([path,text],i)=>[String(i+2).repeat(40),{path,text}]));
      const newBlobs=new Map();
      let stagedBranch='',prWrites=0,otherWrites=0,cloudReads=0;
      const github=async(path,method='GET',body)=>{
        if(path.startsWith('/compare/'))return {status:'ahead',behind_by:0,ahead_by:1,
          files:[{filename:fault==='drift'?'apps/database-mcp-worker/wrangler.jsonc':'scripts/actions-cutover-prepare.mjs'}]};
        if(path.startsWith('/contents/')){
          const name=path.slice('/contents/'.length).split('?')[0];
          return {path:name,type:'file',encoding:'base64',
            content:Buffer.from(name.endsWith('wrangler.jsonc')?sourceText:JSON.stringify(manifest,null,2)+'\n').toString('base64')};
        }
        if(path==='/pulls/3')return {number:3,state:'open',changed_files:2,commits:1,
          head:{sha:oldHead,ref:'db476-'+oldId,repo:{full_name:'lirtual/mcp-workers'}},
          base:{sha:oldBase,ref:'main',repo:{full_name:'lirtual/mcp-workers'}}};
        if(path==='/git/commits/'+oldHead)return {sha:oldHead,parents:[{sha:oldBase}]};
        if(path==='/pulls/3/files?per_page=3')
          return [...oldBlobs.entries()].map(([sha,b])=>({filename:b.path,status:'modified',sha}));
        if(path.startsWith('/git/blobs/')){
          const id=path.slice('/git/blobs/'.length);
          const blob=oldBlobs.get(id)??newBlobs.get(id);
          assert.ok(blob);
          return {sha:id,encoding:'base64',content:Buffer.from(fault==='pr'&&id===String(2).repeat(40)?
            'tampered':blob.text).toString('base64')};
        }
        if(path==='/git/commits/'+nowSha)return {sha:nowSha,tree:{sha:'c'.repeat(40)}};
        if(path==='/git/blobs'&&method==='POST'){
          otherWrites++;const id=String(5+newBlobs.size).repeat(40);
          newBlobs.set(id,{text:Buffer.from(body.content,'base64').toString('utf8')});return {sha:id};
        }
        if(path==='/git/trees'&&method==='POST'){otherWrites++;return {sha:'d'.repeat(40)};}
        if(path==='/git/commits'&&method==='POST'){
          otherWrites++;assert.deepEqual(body.parents,[nowSha]);return {sha:'e'.repeat(40)};
        }
        if(path==='/git/refs'&&method==='POST'){
          otherWrites++;stagedBranch=body.ref.replace('refs/heads/','');return {};
        }
        if(path==='/pulls'&&method==='POST'){
          otherWrites++;prWrites++;if(fault==='post-reserve')throw Error('synthetic rejected PR');
          assert.equal(body.head,stagedBranch);return {number:4};
        }
        if(path==='/pulls/4')return {number:4,state:'open',changed_files:2,commits:1,
          head:{sha:'e'.repeat(40),ref:stagedBranch,repo:{full_name:'lirtual/mcp-workers'}},
          base:{sha:nowSha,ref:'main',repo:{full_name:'lirtual/mcp-workers'}}};
        if(path==='/git/commits/'+'e'.repeat(40))return {sha:'e'.repeat(40),parents:[{sha:nowSha}]};
        if(path==='/pulls/4/files?per_page=3')
          return [...newBlobs].map(([sha,blob],i)=>({filename:Object.keys(oldFiles)[i],status:'modified',sha}));
        throw Error('unexpected mocked GitHub request: '+path);
      };
      const cloud=async(path,method='GET')=>{
        assert.equal(method,'GET');cloudReads++;
        assert.equal(path,'/hyperdrive/configs/'+configId);
        return {id:configId,name:'db476-'+oldId,origin:{scheme:'mysql',host:'mysql.example.net',
          port:3306,database:'catalog',user:'reader'},
          mtls:{sslmode:fault==='config'?'REQUIRE':'VERIFY_IDENTITY',ca_certificate_id:caId},
          caching:{disabled:true}};
      };
      const sql=async(query,params=[])=>{
        const statement=db.prepare(query);
        return query.startsWith('SELECT')?{results:statement.all(...params)}:
          {meta:{changes:Number(statement.run(...params).changes)}};
      };
      const act=()=>recoverFailedHyperdriveCandidate({row,sourceText,source,manifest,
        baseSha:nowSha,runId:82,github,cloud,sql,preflight:async()=>({unprotected:true})});
      if(fault==='success'){
        const result=await act();
        assert.equal(result.phase,'awaiting_confirmation');
        assert.equal(result.prNumber,4);
        assert.equal(prWrites,1);
        const next=db.prepare('SELECT * FROM hyperdrive_operations WHERE operation_id=?').get(result.operationId);
        assert.equal(next.config_id,configId);
        assert.equal(next.ca_certificate_id,caId);
        assert.equal(next.expected_source_sha,nowSha);
        assert.equal(next.phase,'awaiting_confirmation');
        assert.equal(next.ciphertext,null);
        assert.equal(next.apply_run_id,null);
        assert.ok(next.binding_name.endsWith(result.operationId.slice(0,8).toUpperCase()));
        await assert.rejects(act(),error=>error.reason==='recovery_reservation_conflict');
        assert.equal(prWrites,1);
      }else{
        await assert.rejects(act());
        const next=db.prepare('SELECT phase,error_class FROM hyperdrive_operations WHERE operation_id<>?').all(oldId);
        if(fault==='post-reserve'){
          assert.deepEqual(next.map(x=>({...x})),[{phase:'unknown',error_class:'preparation_requires_reconciliation'}]);
          assert.equal(prWrites,1);
        }else {
          assert.equal(next.length,0);
          assert.equal(otherWrites,0);
        }
      }
      assert.equal(JSON.stringify(db.prepare('SELECT * FROM hyperdrive_operations WHERE operation_id=?').get(oldId)),before);
      assert.ok(cloudReads<=2);
    }finally{db.close();}
  }
});
