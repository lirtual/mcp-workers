import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { applyDatabaseHyperdrive, verifyApplyIdentity, classifyApplyVerificationFailure } from './apply-database-hyperdrive-476.mjs';
import { patchSource } from './prepare-database-hyperdrive-476.mjs';
const base='a'.repeat(40), head='b'.repeat(40), tree='c'.repeat(40), preview='d'.repeat(40), merged='e'.repeat(40);
const op='12345678-1234-1234-1234-123456789abc';
const repo={full_name:'lirtual/mcp-workers'};
const env={GITHUB_REPOSITORY:repo.full_name,GITHUB_ACTOR:'lirtual',GITHUB_EVENT_NAME:'workflow_dispatch',
  GITHUB_REF:'refs/heads/main',GITHUB_SHA:base,GITHUB_RUN_ID:'71',GITHUB_RUN_ATTEMPT:'1',
  DATABASE_HYPERDRIVE_OPERATION_ID:op,CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),
  CLOUDFLARE_API_TOKEN:'synthetic-cf',GITHUB_TOKEN:'synthetic-job',DATABASE_GITHUB_ACTIONS_TOKEN:'synthetic-owner'};
const source=readFileSync(new URL('../apps/database-mcp-worker/wrangler.jsonc',import.meta.url),'utf8');
const manifest=JSON.parse(readFileSync(new URL('../apps/database-mcp-worker/hyperdrive-bindings.json',import.meta.url),'utf8'));
// Match the real preparer: Cloudflare config.id is assigned after the other
// provenance fields. Apply must reproduce the exact manifest bytes.
const entry={binding:'HYPERDRIVE_ISOLATED_12345678',dialect:'mysql',
  origin_host:'mysql.example.net',origin_port:3306,origin_database:'catalog',origin_user:'reader',
  ca_certificate_id:'12345678-1234-1234-1234-123456789abc',id:'1'.repeat(32)};
const files=patchSource(source,manifest,entry);
const paths=Object.keys(files);

function fixture(fault) {
  const db=new DatabaseSync(':memory:');
  for(const file of ['0001_connections.sql','0002_transport_and_retired_ids.sql','0003_hyperdrive_operations.sql'])
    db.exec(readFileSync(new URL('../apps/database-mcp-worker/migrations/'+file,import.meta.url),'utf8'));
  db.prepare(`INSERT INTO hyperdrive_operations(operation_id,logical_id,action,expected_revision,phase,
    expected_source_sha,head_sha,config_id,binding_name,pr_number,created_at,updated_at,expires_at,error_class)
    VALUES (?,'isolated','create',0,'running',?,?,?,?,3,1,1,?,'github_apply_dispatch_inflight')`)
    .run(op,base,head,entry.id,entry.binding,Date.now()+600000);
  const writes=[];let main=base, didMerge=false, policyReads=0, ciReads=0, blobReads=0;
  const unprotected = fault?.startsWith('no-protection');
  const pr=()=>({number:3,state:didMerge?'closed':'open',merged:didMerge,draft:fault==='draft',commits:1,changed_files:2,
    mergeable:fault==='merge-denied'?false:true,mergeable_state:'clean',merge_commit_sha:didMerge?merged:preview,
    head:{sha:fault==='stale-head'?'f'.repeat(40):head,ref:'db476-'+op,repo},base:{sha:base,ref:'main',repo}});
  const request=async(url,init={})=>{
    assert.equal(init.redirect,'manual');
    const parsed=new URL(url),path=parsed.pathname.replace('/repos/lirtual/mcp-workers','');
    const method=init.method??'GET',body=init.body?JSON.parse(init.body):undefined;
    if(parsed.hostname==='api.cloudflare.com' && path.endsWith('/query')) {
      const statement=db.prepare(body.sql);
      const result=body.sql.startsWith('SELECT')?{results:statement.all(...body.params)}:
        {meta:{changes:Number(statement.run(...body.params).changes)}};
      return Response.json({success:true,result:[{success:true,...result}]});
    }
    if(method!=='GET' && path!=='/graphql')writes.push({path,method,body,token:init.headers.authorization});
    if(path==='/actions/permissions/workflow'){
      assert.equal(init.headers.authorization,'Bearer synthetic-owner');
      return Response.json({can_approve_pull_request_reviews:fault!=='no-protection-pr-disabled'});
    }
    if(path==='/actions/workflows/ci.yml')return Response.json({id:2,state:'active',path:'.github/workflows/ci.yml'});
    if(path==='/git/ref/heads/db476-'+op)return Response.json({object:{sha:fault==='no-protection-ref'?'f'.repeat(40):head}});
    if(path==='/contents/.github/workflows/ci.yml')return Response.json({path:'.github/workflows/ci.yml',type:'file',encoding:'base64',
      content:Buffer.from(readFileSync(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8')).toString('base64')});
    if(path==='/actions/workflows/ci.yml/dispatches') {
      assert.equal(init.headers.authorization,'Bearer synthetic-owner');
      assert.deepEqual(body,{ref:'db476-'+op,return_run_details:true,inputs:{worker:'database-mcp-worker',candidate_sha:head}});
      if(fault==='no-protection-204')return new Response(null,{status:204});
      if(fault==='no-protection-timeout')throw Error('synthetic unknown dispatch');
      return Response.json({workflow_run_id:fault==='no-protection-bad-id'?0:98});
    }
    if(path==='/actions/runs/98') {
      ciReads++;
      return Response.json({id:98,workflow_id:2,run_attempt:fault==='no-protection-rerun'?2:1,repository:repo,
        event:fault==='no-protection-event'?'push':'workflow_dispatch',
        path:fault==='no-protection-workflow'?'.github/workflows/release.yml':'.github/workflows/ci.yml',
        actor:{login:fault==='no-protection-owner'?'attacker':'lirtual'},triggering_actor:{login:'lirtual'},
        head_branch:fault==='no-protection-branch'?'main':'db476-'+op,
        head_sha:fault==='no-protection-sha'?'f'.repeat(40):head,
        status:fault==='no-protection-pending'||(fault==='no-protection-wait-success'&&ciReads===1)?'queued':'completed',
        conclusion:fault==='no-protection-failed'?'failure':'success'});
    }
    if(path==='/actions/runs/98/jobs') {
      let jobs=['Application checks','Database integration','Required checks gate'].map(name=>({name,run_id:98,
        head_sha:fault==='no-protection-job-sha'?'f'.repeat(40):head,
        status:fault==='no-protection-job-queued'?'queued':'completed',
        conclusion:fault==='no-protection-skipped'&&name==='Database integration'?'skipped':
          fault==='no-protection-gate-failed'&&name==='Required checks gate'?'failure':'success'}));
      if(fault==='no-protection-missing-job')jobs.pop();
      if(fault==='no-protection-duplicate-job')jobs[2]={...jobs[1]};
      return Response.json({total_count:jobs.length,jobs});
    }
    if(path==='/git/ref/heads/main')return Response.json({object:{sha:fault==='main-advanced'||(fault==='no-protection-late-main'&&ciReads>0)?'f'.repeat(40):main}});
    if(path.startsWith('/contents/')) {
      const file=path.slice('/contents/'.length);
      assert.equal(parsed.searchParams.get('ref'),base);
      return Response.json({path:file,type:'file',encoding:'base64',content:Buffer.from(
        file.endsWith('wrangler.jsonc')?source:JSON.stringify(manifest)).toString('base64')});
    }
    if(path.endsWith('/hyperdrive/configs/'+entry.id))return Response.json({success:true,result:{id:entry.id,name:'db476-'+op,
      origin:{scheme:'mysql',host:entry.origin_host,port:3306,database:'catalog',user:'reader'},
      mtls:{sslmode:'VERIFY_IDENTITY',ca_certificate_id:entry.ca_certificate_id},caching:{disabled:true}}});
    if(path==='/pulls/3' && method==='GET')return Response.json(pr());
    if(path==='/git/commits/'+head)return Response.json({sha:head,parents:[{sha:base}],tree:{sha:tree}});
    if(path==='/pulls/3/files')return Response.json(paths.map((filename,i)=>({filename,status:fault==='rename'?'renamed':'modified',sha:String(i+2).repeat(40)})));
    if(path.startsWith('/git/blobs/')) {
      blobReads++;
      const index=Number(path.at(-1))-2,sha=path.split('/').at(-1);
      return Response.json({sha,encoding:'base64',content:Buffer.from(fault==='content-drift'||(fault==='no-protection-late-content'&&blobReads>2)?'secret injection':files[paths[index]]).toString('base64')});
    }
    if(path==='/git/trees/'+tree)return Response.json({sha:tree,truncated:false,
      tree:paths.map(path=>({path,mode:fault==='symlink'?'120000':fault==='executable'?'100755':'100644',type:'blob'}))});
    if(path==='/branches/main') {
      policyReads++;
      return Response.json({name:'main',protected:unprotected
        ? fault==='no-protection-policy-changed' && policyReads>2
        : true});
    }
    if(path==='/branches/main/protection') {
      if(fault==='null-policy')return Response.json(null);
      if(fault==='policy-unavailable')return new Response(null,{status:403});
      return Response.json({enforce_admins:{enabled:fault!=='admin-bypass'},required_status_checks:{strict:fault!=='weak-policy',
        contexts:fault==='missing-required-check'?['Other check']:['Required checks gate'],checks:[{context:'Required checks gate',app_id:15368}]},
        required_pull_request_reviews:{required_approving_review_count:1,require_code_owner_reviews:false}});
    }
    if(path==='/rulesets')return fault==='no-protection-rules-unavailable'?new Response(null,{status:403}):Response.json(fault==='unknown-rules'?[{id:1}]:[]);
    if(path==='/graphql')return Response.json({data:{repository:{pullRequest:{headRefOid:head,baseRefOid:base,
      reviewDecision:unprotected?null:fault==='review-missing'?'REVIEW_REQUIRED':'APPROVED',mergeStateStatus:'CLEAN'}}}});
    if(path==='/commits/'+head+'/check-runs')return Response.json({total_count:1,check_runs:[{name:'Required checks gate',
      head_sha:head,status:fault==='pending-ci'?'in_progress':'completed',conclusion:fault==='unknown-ci'?null:'success',
      app:{id:fault==='wrong-provider'?123:15368,slug:'github-actions'},check_suite:{id:81}}]});
    if(path==='/commits/'+head+'/status')return Response.json({sha:head,total_count:0,statuses:[]});
    if(path==='/check-suites/81')return Response.json({head_sha:head,pull_requests:fault==='unrecognized-check'?[]:[{number:3,head:{sha:head}}]});
    if(path==='/actions/runs')return Response.json({total_count:1,workflow_runs:[{head_sha:head,
      event:fault==='dispatch-ci'?'workflow_dispatch':'pull_request',path:'.github/workflows/ci.yml',
      check_suite_id:81,status:'completed',conclusion:'success'}]});
    if(path==='/git/commits/'+preview)return Response.json({sha:preview,tree:{sha:tree},parents:[{sha:base},{sha:head}]});
    if(path==='/pulls/3/merge') {
      assert.deepEqual(body,{sha:head,merge_method:'merge'});
      assert.equal(init.headers.authorization,'Bearer synthetic-job');
      if(fault==='merge-http-denied')return new Response(null,{status:405});
      if(fault==='merge-timeout')throw Error('synthetic lost receipt');
      didMerge=true;main=fault==='post-merge-advance'?'f'.repeat(40):merged;
      return Response.json({merged:true,sha:merged});
    }
    if(path==='/git/commits/'+merged)return Response.json({sha:merged,tree:{sha:tree},
      parents:[{sha:fault==='merge-base-race'?'f'.repeat(40):base},{sha:head}]});
    if(path==='/actions/workflows/release.yml/dispatches') {
      if(fault==='legacy204')return new Response(null,{status:204});
      if(fault==='dispatch-timeout')throw Error('synthetic unknown release');
      return Response.json({workflow_run_id:99});
    }
    if(path==='/actions/runs/99')return Response.json({id:99,event:'workflow_dispatch',path:'.github/workflows/release.yml',
      actor:{login:'lirtual'},head_branch:'main',head_sha:fault==='wrong-run'?'f'.repeat(40):merged,status:'queued'});
    throw Error('Unexpected mocked request: '+path);
  };
  return {db,request,writes};
}
test('reviewed helper failures preserve specific, nonsecret D1 diagnostics', () => {
  for (const [reason, expected] of [
    ['github_pr_identity_drift','apply_pr_stale'],
    ['github_pr_parent_drift','apply_source_invalid'],
    ['github_pr_diff_invalid','apply_source_invalid'],
    ['github_pr_diff_not_allowlisted','apply_source_invalid'],
    ['github_pr_content_drift','apply_source_invalid'],
    ['source_format_unknown','apply_source_invalid'],
    ['main_sha_changed','apply_main_advanced'],
    ['github_protection_unavailable','apply_policy_unavailable'],
    ['github_ci_unavailable','apply_ci_receipt_unknown'],
    ['apply_ci_failed','apply_ci_failed'],
  ]) assert.equal(classifyApplyVerificationFailure({reason}), expected);
  assert.equal(classifyApplyVerificationFailure(new Error(
    'Database Hyperdrive verification failed: SQL response caching is not disabled')),
    'apply_config_drift');
  for (const error of [
    {reason:'source_format_unknown:private-token'}, {reason:'upstream_secret'},
    new Error('upstream private response password=secret'),
    {message:'Database Hyperdrive verification failed: private origin string'},
  ]) assert.equal(classifyApplyVerificationFailure(error), 'apply_verification_blocked');
});
test('pre-CI stale PR and blob drift retain exact sanitized classification, never merge',async()=>{
  for(const [fault, expected] of [
    ['stale-head','apply_pr_stale'],['rename','apply_source_invalid'],
    ['content-drift','apply_source_invalid'],
  ]){
    const {db,request,writes}=fixture(fault);
    try {
      await assert.rejects(applyDatabaseHyperdrive(env,request));
      const row=db.prepare('SELECT phase,error_class,merged_sha,ci_run_id FROM hyperdrive_operations').get();
      assert.equal(row.phase,'unknown');
      assert.equal(row.error_class,expected);
      assert.equal(row.merged_sha,null);
      assert.equal(row.ci_run_id,null);
      assert.deepEqual(writes,[]);
    } finally { db.close(); }
  }
});
test('apply exact Owner/main identity rejects reruns and malformed IDs before any I/O',()=>{
  verifyApplyIdentity(env);
  for(const [key,value] of [['GITHUB_ACTOR','attacker'],['GITHUB_RUN_ATTEMPT','2'],
    ['GITHUB_SHA','bad'],['GITHUB_REF','refs/heads/other'],['DATABASE_HYPERDRIVE_OPERATION_ID','../bad']])
    assert.throws(()=>verifyApplyIdentity({...env,[key]:value}));
});
for(const fault of ['null-policy','policy-unavailable','unknown-rules','review-missing','stale-head','unknown-ci',
  'pending-ci','dispatch-ci','merge-denied','draft','main-advanced','rename','content-drift','symlink',
  'admin-bypass','weak-policy','missing-required-check','wrong-provider','unrecognized-check','executable']) {
  test('apply fails closed before merge/deployment: '+fault,async()=>{
    const {db,request,writes}=fixture(fault);
    try {
      await assert.rejects(applyDatabaseHyperdrive(env,request));
      assert.deepEqual(writes,[]);
      const row=db.prepare('SELECT phase,error_class FROM hyperdrive_operations').get();
      assert.equal(row.phase,'unknown');
      assert.notEqual(row.error_class,'apply_release_pending');
      assert.equal(db.prepare('SELECT COUNT(*) n FROM database_connections').get().n,0);
      await assert.rejects(applyDatabaseHyperdrive(env,request));
      assert.deepEqual(writes,[]);
    } finally {db.close();}
  });
}
for(const fault of ['merge-http-denied','merge-timeout','merge-base-race','post-merge-advance']) {
  test('no deployment or repeated merge after '+fault,async()=>{
    const {db,request,writes}=fixture(fault);
    try {
      await assert.rejects(applyDatabaseHyperdrive(env,request));
      assert.equal(writes.length,1);assert.equal(writes[0].method,'PUT');
      assert.equal(db.prepare('SELECT phase FROM hyperdrive_operations').get().phase,'unknown');
      await assert.rejects(applyDatabaseHyperdrive(env,request));assert.equal(writes.length,1);
    } finally {db.close();}
  });
}
test('proven actual merge SHA pins the sole release; run receipt is not activation/completion',async()=>{
  const {db,request,writes}=fixture();
  try {
    const result=await applyDatabaseHyperdrive(env,request);
    assert.equal(result.mergedSha,merged);assert.notEqual(result.mergedSha,preview);
    assert.equal(result.phase,'running');assert.equal(writes.length,2);
    assert.deepEqual(writes[1].body,{ref:'main',return_run_details:true,inputs:{worker:'database-mcp-worker',
      deploy_to_production:'true',database_expected_release_sha:merged,database_hyperdrive_apply_id:op}});
    assert.equal(writes[1].token,'Bearer synthetic-owner');
    assert.deepEqual({...db.prepare('SELECT phase,merged_sha,apply_run_id,release_run_id FROM hyperdrive_operations').get()},
      {phase:'running',merged_sha:merged,apply_run_id:71,release_run_id:99});
    assert.equal(db.prepare('SELECT COUNT(*) n FROM database_connections').get().n,0);
    await assert.rejects(applyDatabaseHyperdrive(env,request));assert.equal(writes.length,2);
  } finally {db.close();}
});
for(const fault of ['legacy204','dispatch-timeout','wrong-run']) {
  test('unproven release receipt stays unknown without redispatch: '+fault,async()=>{
    const {db,request,writes}=fixture(fault);
    try {
      await assert.rejects(applyDatabaseHyperdrive(env,request));
      const row=db.prepare('SELECT phase,merged_sha,release_run_id FROM hyperdrive_operations').get();
      assert.equal(row.phase,'unknown');assert.equal(row.merged_sha,merged);assert.equal(row.release_run_id,null);
      await assert.rejects(applyDatabaseHyperdrive(env,request));assert.equal(writes.length,2);
    } finally {db.close();}
  });
}

for(const fault of ['no-protection-204','no-protection-timeout','no-protection-bad-id',
  'no-protection-sha','no-protection-branch','no-protection-owner','no-protection-workflow',
  'no-protection-pending','no-protection-failed','no-protection-skipped','no-protection-ref',
  'no-protection-policy-changed','no-protection-rules-unavailable',
  'no-protection-job-sha','no-protection-job-queued','no-protection-gate-failed','no-protection-missing-job',
  'no-protection-duplicate-job','no-protection-late-content','no-protection-late-main','no-protection-rerun','no-protection-event']) {
  test('unprotected policy never merges/deploys without exact successful CI: '+fault,async()=>{
    const {db,request,writes}=fixture(fault);
    try {
      await assert.rejects(applyDatabaseHyperdrive(env,request,{wait:async()=>{}}));
      assert.ok(writes.every(w=>w.path==='/actions/workflows/ci.yml/dispatches'));
      assert.ok(writes.length<=1);
      const count=writes.length;
      assert.equal(db.prepare('SELECT phase FROM hyperdrive_operations').get().phase,'unknown');
      await assert.rejects(applyDatabaseHyperdrive(env,request,{wait:async()=>{}}));
      assert.equal(writes.length,count);
    } finally {db.close();}
  });
}
for(const fault of ['no-protection','no-protection-wait-success','no-protection-pr-disabled']) {
  test('unprotected exact candidate with successful full CI may merge and dispatch pinned release: '+fault,async()=>{
    const {db,request,writes}=fixture(fault);
    try {
      const result=await applyDatabaseHyperdrive(env,request,{wait:async()=>{}});
      assert.equal(result.phase,'running');assert.equal(result.mergedSha,merged);
      assert.deepEqual(writes.map(w=>w.path),['/actions/workflows/ci.yml/dispatches','/pulls/3/merge',
        '/actions/workflows/release.yml/dispatches']);
      assert.equal(db.prepare('SELECT ci_run_id FROM hyperdrive_operations').get().ci_run_id,98);
    } finally {db.close();}
  });
}
