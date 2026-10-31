import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { removeHyperdriveBindingSource } from './prepare-database-hyperdrive-unbind-476.mjs';

// Keep a fully synthetic unbinding fixture after all live Hyperdrives are retired.
const deployedSource = readFileSync(new URL('../apps/database-mcp-worker/wrangler.jsonc', import.meta.url),'utf8');
const target = { binding:'HYPERDRIVE_TEST_FIXTURE', id:'11111111-1111-4111-8111-111111111111', dialect:'mysql' };
const manifest = [target];
const source = deployedSource.replace('  "hyperdrive": [],',
  '  "hyperdrive": [\n    { "binding": "'+target.binding+'", "id": "'+target.id+'" }\n  ],');
assert.equal(JSON.parse(source).hyperdrive.length,1);

test('unbinding stages precisely the reviewed Wrangler binding and manifest, leaving unrelated settings intact',()=>{
  const files = removeHyperdriveBindingSource(source,manifest,target.binding,target.id);
  assert.deepEqual(Object.keys(files).sort(),['apps/database-mcp-worker/hyperdrive-bindings.json','apps/database-mcp-worker/wrangler.jsonc']);
  const before=JSON.parse(source), after=JSON.parse(files['apps/database-mcp-worker/wrangler.jsonc']);
  assert.deepEqual({...before,hyperdrive:[]},{...after,hyperdrive:[]});
  const retained=before.hyperdrive.filter(x=>x.binding!==target.binding||x.id!==target.id);
  assert.deepEqual(after.hyperdrive,retained);
  assert.deepEqual(JSON.parse(files['apps/database-mcp-worker/hyperdrive-bindings.json']),
    manifest.filter(x=>x.binding!==target.binding||x.id!==target.id));
  assert.ok(files['apps/database-mcp-worker/wrangler.jsonc'].includes('"database_id": "cbfe6a05-4979-4e6a-9cc2-4f6468586e4a"'));
  assert.ok(!JSON.stringify(files).includes('PASSWORD'));
});
test('unbinding rejects wrong or non-unique target before any writes',()=>{
  for(const [name,id] of [['MISSING',target.id],[target.binding,'wrong-id'],['HYPERDRIVE_AIVEN_OPENLIST','elsewhere']])
    assert.throws(()=>removeHyperdriveBindingSource(source,manifest,name,id));
  assert.throws(()=>removeHyperdriveBindingSource(source,[...manifest,...manifest],target.binding,target.id));
});

const blobSha=content=>{const buffer=Buffer.from(content);return createHash('sha1').update(Buffer.from('blob '+buffer.length+'\0')).update(buffer).digest('hex');};
const sha='a'.repeat(40), commitSha='b'.repeat(40), treeSha='c'.repeat(40);
const jobEnv={GITHUB_REPOSITORY:'lirtual/mcp-workers',GITHUB_EVENT_NAME:'workflow_dispatch',
  GITHUB_ACTOR:'lirtual',GITHUB_REF:'refs/heads/main',GITHUB_SHA:sha,
  DATABASE_RETIRE_ID:'isolated',DATABASE_RETIRE_REVISION:'3',CLOUDFLARE_ACCOUNT_ID:'d'.repeat(32),
  CLOUDFLARE_API_TOKEN:'synthetic-cloud',GITHUB_TOKEN:'synthetic-job',DATABASE_GITHUB_ACTIONS_TOKEN:'synthetic-owner'};
function mockStage({active=false,shared=false,pending=false,branchExists=false,existingPr='none',mainSha=sha}={}){
  const writes=[],blobs=[];let tree,branchName;
  if(branchExists){
    const existing=removeHyperdriveBindingSource(source,manifest,target.binding,target.id);
    blobs.push(...Object.values(existing).map(content=>({id:blobSha(content),content})));
    tree=Object.keys(existing).map((path,i)=>({path,sha:blobs[i].id}));
  }
  const request=async(url,init={})=>{
    const u=new URL(url),path=u.pathname,method=init.method??'GET',body=init.body?JSON.parse(init.body):undefined;
    if(method!=='GET')writes.push({path,method,body});
    if(path.endsWith('/query')){
      if(body.sql.startsWith('SELECT id,'))return Response.json({success:true,result:[{success:true,results:[{
        id:'isolated',transport:'hyperdrive',status:active?'active':'disabled',revision:3,
        config_id:target.id,binding_name:target.binding}]}]});
      return Response.json({success:true,result:[{success:true,results:[{n:body.sql.includes('hyperdrive_operations')?Number(pending):Number(shared)}]}]});
    }
    if(path.endsWith('/branches/main')){
      assert.equal(init.headers.authorization,'Bearer synthetic-owner');
      return Response.json({name:'main',protected:false});
    }
    if(path.endsWith('/rulesets'))return Response.json([]);
    if(path.endsWith('/actions/workflows/ci.yml'))return Response.json({id:1,path:'.github/workflows/ci.yml',state:'active'});
    if(path.endsWith('/git/ref/heads/main'))return Response.json({object:{sha:mainSha}});
    if(path.endsWith('/contents/.github/workflows/ci.yml'))return Response.json({path:'.github/workflows/ci.yml',type:'file',encoding:'base64',content:
      Buffer.from(readFileSync(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8')).toString('base64')});
    if(path.includes('/git/ref/heads/db476-unbind-')){branchName=path.split('/').at(-1);return branchExists?Response.json({ref:'refs/heads/'+branchName,object:{sha:commitSha}}):new Response(null,{status:404});}
    if(path.endsWith('/pulls') && method==='GET')return Response.json(existingPr==='valid'||existingPr==='blobMismatch'?[{number:73}]:existingPr==='duplicate'?[{number:73},{number:74}]:[]);
    if(path.includes('/git/blobs/') && method==='GET'){
      const b=blobs.find(x=>x.id===path.split('/').at(-1));
      if(!b)throw Error('unknown blob');
      return Response.json({sha:b.id,encoding:'base64',content:Buffer.from(existingPr==='blobMismatch'?'wrong-source-content':b.content).toString('base64')});
    }
    if(path.endsWith('/git/commits/'+mainSha))return Response.json({tree:{sha:treeSha}});
    if(path.endsWith('/git/blobs')&&method==='POST'){
      const content=Buffer.from(body.content,'base64').toString();
      assert.ok(!content.includes('synthetic-cloud'));
      const id=blobSha(content);blobs.push({id,content});return Response.json({sha:id});
    }
    if(path.endsWith('/git/trees')&&method==='POST'){
      tree=body.tree;return Response.json({sha:treeSha});
    }
    if(path.endsWith('/git/commits')&&method==='POST')return Response.json({sha:commitSha});
    if(path.endsWith('/git/commits/'+commitSha))return Response.json({sha:commitSha,tree:{sha:treeSha},parents:[{sha:mainSha}]});
    if(path.endsWith('/git/refs')&&method==='POST')return Response.json({});
    if(path.endsWith('/pulls')&&method==='POST'){
      assert.equal(body.draft,true);return Response.json({number:73});
    }
    if(path.endsWith('/pulls/73'))return Response.json({number:73,state:'open',draft:true,commits:1,changed_files:2,
      head:{sha:commitSha,ref:branchName,repo:{full_name:'lirtual/mcp-workers'}},base:{ref:'main',sha:mainSha,repo:{full_name:'lirtual/mcp-workers'}}});
    if(path.endsWith('/pulls/73/files'))return Response.json(tree.map(x=>({filename:x.path,status:'modified',sha:x.sha})));
    throw Error('unexpected synthetic request: '+path);
  };
  return {request,writes,blobs};
}
test('Owner retirement staging creates only two nonsecret PR files and never deploys or deletes',async()=>{
  const {stageHyperdriveUnbind}=await import('./prepare-database-hyperdrive-unbind-476.mjs');
  const f=mockStage();
  assert.deepEqual(await stageHyperdriveUnbind({env:jobEnv,request:f.request,sourceText:source,manifest}),
    {phase:'awaiting_unbind_review',prNumber:73});
  assert.equal(f.blobs.length,2);
  assert.equal(f.writes.filter(x=>x.method==='POST'&&x.path.includes('/d1/database/')).length,3);
  assert.ok(!f.writes.some(x=>x.path.includes('/hyperdrive/configs')||x.path.includes('/deployments')||x.path.includes('/versions')));
  assert.deepEqual(f.writes.filter(x=>x.path.endsWith('/pulls')).map(x=>x.body.draft),[true]);
});
test('staging never writes source for active, shared, pending, or previously attempted operations',async()=>{
  const {stageHyperdriveUnbind}=await import('./prepare-database-hyperdrive-unbind-476.mjs');
  for(const condition of ['active','shared','pending','branchExists']){
    const f=mockStage({[condition]:true});
    await assert.rejects(stageHyperdriveUnbind({env:jobEnv,request:f.request,sourceText:source,manifest}),
      /unbinding blocked/);
    assert.ok(!f.writes.some(x=>x.path.includes('/git/')||x.path.endsWith('/pulls')));
  }
});

test('already unbound changes do not create a new PR and leave final retirement to existing proof gate',async()=>{
  const {stageHyperdriveUnbind}=await import('./prepare-database-hyperdrive-unbind-476.mjs');
  const files=removeHyperdriveBindingSource(source,manifest,target.binding,target.id);
  const f=mockStage();
  assert.deepEqual(await stageHyperdriveUnbind({env:jobEnv,request:f.request,
    sourceText:files['apps/database-mcp-worker/wrangler.jsonc'],
    manifest:manifest.filter(x=>x.binding!==target.binding||x.id!==target.id)}),
    {phase:'already_unbound'});
  assert.ok(!f.writes.some(x=>x.path.includes('/git/')||x.path.endsWith('/pulls')));
});
test('existing release workflow only allows D1 deletion when unbinding stage confirms absent binding',()=>{
  const yml=readFileSync(new URL('../.github/workflows/release.yml',import.meta.url),'utf8');
  const section=yml.split('  database-hyperdrive-retire:')[1].split('  checks:')[0];
  assert.match(section,/contents: write/);
  assert.match(section,/pull-requests: write/);
  assert.match(section,/id: unbind/);
  assert.match(section,/scripts\/prepare-database-hyperdrive-unbind-476\.mjs/);
  assert.match(section,/if: steps\.unbind\.outputs\.action == 'retire'/);
  assert.doesNotMatch(section,/deploy_to_production == true/);
});

test('retries after a lost PR response recover exactly one reviewed Draft PR using read-only GitHub evidence',async()=>{
  const {stageHyperdriveUnbind}=await import('./prepare-database-hyperdrive-unbind-476.mjs');
  const f=mockStage({branchExists:true,existingPr:'valid'});
  assert.deepEqual(await stageHyperdriveUnbind({env:jobEnv,request:f.request,sourceText:source,manifest}),
    {phase:'awaiting_unbind_review',prNumber:73});
  assert.equal(f.writes.filter(x=>x.path.includes('/git/')||x.path.endsWith('/pulls')).length,0);
  assert.equal(f.writes.length,3); // D1 read-only queries only
});
test('recovery rejects unknown, duplicate or tampered PRs without a second GitHub write',async()=>{
  const {stageHyperdriveUnbind}=await import('./prepare-database-hyperdrive-unbind-476.mjs');
  for(const existingPr of ['none','duplicate','blobMismatch']){
    const f=mockStage({branchExists:true,existingPr});
    await assert.rejects(stageHyperdriveUnbind({env:jobEnv,request:f.request,sourceText:source,manifest}),
      /unbinding blocked/);
    assert.equal(f.writes.filter(x=>x.path.includes('/git/')||x.path.endsWith('/pulls')).length,0);
  }
});

test('one disabled connection keeps its unbinding branch identity across main advancement',async()=>{
  const {stageHyperdriveUnbind}=await import('./prepare-database-hyperdrive-unbind-476.mjs');
  const first=mockStage(),laterSha='e'.repeat(40),second=mockStage({mainSha:laterSha});
  await stageHyperdriveUnbind({env:jobEnv,request:first.request,sourceText:source,manifest});
  await stageHyperdriveUnbind({env:{...jobEnv,GITHUB_SHA:laterSha},request:second.request,
    sourceText:source,manifest});
  const branchOf=f=>f.writes.find(x=>x.path.endsWith('/git/refs'))?.body.ref;
  assert.match(branchOf(first),/^refs\/heads\/db476-unbind-[0-9a-f]{24}$/);
  assert.equal(branchOf(first),branchOf(second));
});
