// Local-only integration seam: Portal-authenticated MCP, Wrangler D1+Workflows and read-only MCP fixture.
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
const base=process.env.S1_LOCAL_URL ?? 'http://127.0.0.1:8787';
const token=process.env.S1_LOCAL_TOKEN;
if(!token)throw Error('S1_LOCAL_TOKEN required');
const cli=new Client({name:'workflow-s1-local-smoke',version:'0.1.0'});
const transport=new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+token}}});
let tests=0;
function ok(x,message){assert.ok(x,message);tests++;}
async function tool(name,args,expectError){
  const response=await cli.callTool({name,arguments:args});
  assert.ok(response.content && response.content.length);
  const value=JSON.parse(response.content[0].text);
  if(expectError){assert.equal(response.isError,true,name+' expected MCP error: '+JSON.stringify(value));assert.equal(value.error,expectError);}
  else{assert.notEqual(response.isError,true,name+' failed: '+JSON.stringify(value));}
  return value;
}
const definition={version:1,name:'S1 local smoke',steps:[
 {id:'read',uses:'s1.readonly_mcp',with:{tool:'echo',arguments:{value:{ref:'inputs.subject'}}}},
 {id:'report',uses:'result.emit',needs:['read'],with:{data:{ref:'steps.read.output'}}}
]};
async function awaitOutcome(run_id){
  for(let i=0;i<25;i++){
    const status=await tool('workflow_status',{run_id});
    if(['succeeded','failed','indeterminate','cancelled'].includes(status.status))return status;
    await new Promise(r=>setTimeout(r,400));
  }
  throw Error('Run did not settle');
}
try{
  await cli.connect(transport);
  const listed=await cli.listTools();
  ok(listed.tools.some(x=>x.name==='workflow_publish'),'publish tool exposed');
  for(const name of ['workflow_status','workflow_result']){
    const metadata=listed.tools.find(x=>x.name===name);
    ok(metadata?.annotations?.readOnlyHint===false,`${name} must not claim to be read-only because reconciliation may mutate D1 or resume an admitted Run`);
  }
  ok(!listed.tools.some(x=>x.name.includes('webhook')||x.name.includes('github')),'no S2/S3 tools');
  let w=await tool('workflow_create',{definition:JSON.stringify(definition)});
  ok(w.state==='draft'&&w.draft_revision===1,'creates only Draft');
  let id=w.workflow_id;
  ok((await tool('workflow_get',{workflow_id:id})).published_version_id===null,'draft no implicit Publish');
  ok((await tool('workflow_validate',{workflow_id:id,revision:1})).valid===true,'validation succeeds');
  await tool('workflow_publish',{workflow_id:id,expected_revision:2},'revision_conflict');
  const published=await tool('workflow_publish',{workflow_id:id,expected_revision:1});
  ok(!!published.published_version_id,'explicit Published Version');
  const first=await tool('workflow_run',{workflow_id:id,inputs:{subject:'sdk fixture local success'},idempotency_key:'s1-local-'+id});
  ok(first.published_version_id===published.published_version_id,'Run pins published plan');
  const same=await tool('workflow_run',{workflow_id:id,inputs:{subject:'sdk fixture local success'},idempotency_key:'s1-local-'+id});
  ok(same.run_id===first.run_id,'idempotency reuses logical Run');
  const keyed=await tool('workflow_run',{workflow_id:id,inputs:{subject:'same content',count:2},idempotency_key:'key-order-'+id});
  const reordered=await tool('workflow_run',{workflow_id:id,inputs:{count:2,subject:'same content'},idempotency_key:'key-order-'+id});
  ok(reordered.run_id===keyed.run_id,'same input object with reordered JSON keys reuses admitted Run');
  await tool('workflow_run',{workflow_id:id,inputs:{subject:'different'},idempotency_key:'s1-local-'+id},'idempotency_conflict');
  const done=await awaitOutcome(first.run_id);
  ok(done.status==='succeeded','real SDK fixture call: '+JSON.stringify(done));
  ok(done.steps.length===2&&done.steps.every(x=>x.status==='succeeded'),'both DAG Steps succeeded');
  const result=await tool('workflow_result',{run_id:first.run_id});
  ok(result.result?.content?.[0]?.text==='sdk fixture local success','read-only content from MCP SDK');
  const changed=structuredClone(definition);changed.name='S1 local changed Draft';
  const updated=await tool('workflow_update',{workflow_id:id,expected_revision:1,definition:JSON.stringify(changed)});
  ok(updated.draft_revision===2,'Draft edit after Publish');
  await tool('workflow_update',{workflow_id:id,expected_revision:1,definition:JSON.stringify(changed)},'revision_conflict');
  ok((await tool('workflow_get',{workflow_id:id})).published_version_id===published.published_version_id,'Draft edit does not activate');
  const republished=await tool('workflow_publish',{workflow_id:id,expected_revision:2});
  ok(republished.published_version_id!==published.published_version_id,'explicit republish installs new version');
  const replay=await tool('workflow_run',{workflow_id:id,inputs:{subject:'sdk fixture local success'},idempotency_key:'s1-local-'+id});
  ok(replay.run_id===first.run_id&&replay.published_version_id===published.published_version_id,'replay pinned across republish');
  ok((await tool('workflow_pause',{workflow_id:id})).state==='paused','paused');
  ok((await tool('workflow_publish',{workflow_id:id,expected_revision:2})).state==='paused','repeated Publish must not silently resume a Paused Workflow');
  await tool('workflow_run',{workflow_id:id,inputs:{subject:'blocked'},idempotency_key:'blocked-'+id},'workflow_not_active');
  ok((await tool('workflow_run',{workflow_id:id,inputs:{subject:'sdk fixture local success'},idempotency_key:'s1-local-'+id})).run_id===first.run_id,'accepted Run across pause');
  await tool('workflow_resume',{workflow_id:id});
  const second=await tool('workflow_run',{workflow_id:id,inputs:{subject:'second run'},idempotency_key:'second-'+id});
  ok(second.published_version_id===republished.published_version_id,'new Run uses new version');
  ok((await awaitOutcome(second.run_id)).status==='succeeded','new version Run succeeds');
  ok((await tool('workflow_result',{run_id:second.run_id})).result.content[0].text==='second run','new Run result correct');
  const invalid=JSON.stringify({...definition,steps:[{id:'x',uses:'shell.run',with:{command:'no'}}]});
  const invalidDraft=await tool('workflow_create',{definition:invalid});
  ok(invalidDraft.state==='draft','incomplete/invalid definition may remain an editable Draft');
  const invalidPreview=await tool('workflow_validate',{workflow_id:invalidDraft.workflow_id,revision:1});
  ok(invalidPreview.valid===false&&invalidPreview.issues?.length>0,'validation returns actionable issues instead of losing Draft');
  await tool('workflow_publish',{workflow_id:invalidDraft.workflow_id,expected_revision:1},'invalid_definition');
  ok((await tool('workflow_get',{workflow_id:invalidDraft.workflow_id})).published_version_id===null,'rejected Publish leaves prior state unchanged');
  const yaml='version: 1\nname: YAML Draft\nsteps:\n  - id: emit\n    uses: result.emit\n    with:\n      data: hello-yaml\n';
  const yamlDraft=await tool('workflow_create',{definition:yaml});
  ok((await tool('workflow_get',{workflow_id:yamlDraft.workflow_id})).definition===yaml,'YAML Draft can be read back exactly');
  ok((await tool('workflow_validate',{workflow_id:yamlDraft.workflow_id,revision:1})).valid===true,'YAML Draft validates');
  const brokenYaml=await tool('workflow_create',{definition:'version: [unfinished'});
  ok((await tool('workflow_get',{workflow_id:brokenYaml.workflow_id})).definition==='version: [unfinished','malformed Draft remains readable');
  ok((await tool('workflow_validate',{workflow_id:brokenYaml.workflow_id,revision:1})).valid===false,'malformed Draft validation reports error');
  const bad=await fetch(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',authorization:'Bearer invalid',accept:'application/json'},body:'{}'});
  ok(bad.status===401,'Portal auth rejects wrong bearer');
  // Two simultaneous publishes of the same Draft must have one atomic winner.
  const competing=await tool('workflow_create',{definition:JSON.stringify(definition)});
  const publishOne=()=>cli.callTool({name:'workflow_publish',arguments:{workflow_id:competing.workflow_id,expected_revision:1}});
  const publishResults=await Promise.all([publishOne(),publishOne()]);
  const winners=publishResults.filter(x=>!x.isError);
  ok(winners.length===2,'concurrent identical Publish should resolve idempotently');
  const winningVersion=JSON.parse(winners[0].content[0].text).published_version_id;
  ok(JSON.parse(winners[1].content[0].text).published_version_id===winningVersion,'concurrent Publish must not create a second Version');
  ok((await tool('workflow_get',{workflow_id:competing.workflow_id})).published_version_id===winningVersion,'CAS active version stable');
  // A rejected read-only tool argument fails the prerequisite; dependent Step is skipped.
  const failingDef={version:1,name:'Failed prerequisite',steps:[
    {id:'read',uses:'s1.readonly_mcp',with:{tool:'echo',arguments:{value:123}}},
    {id:'dependent',uses:'result.emit',needs:['read'],with:{data:'never emitted'}}
  ]};
  const f=await tool('workflow_create',{definition:JSON.stringify(failingDef)});
  await tool('workflow_publish',{workflow_id:f.workflow_id,expected_revision:1});
  const fr=await tool('workflow_run',{workflow_id:f.workflow_id,inputs:{}});
  const fs=await awaitOutcome(fr.run_id);
  ok(fs.status==='failed','invalid read-only target input fails the Run');
  ok(fs.steps.some(x=>x.step_id==='read'&&x.status==='failed')&&fs.steps.some(x=>x.step_id==='dependent'&&x.status==='skipped'),'failed prerequisite does not execute dependent Step');
  // A runtime string used as an if predicate is not silently coerced to true.
  const conditionDef={version:1,name:'Runtime boolean only',steps:[{id:'emit',uses:'result.emit',if:{ref:'inputs.flag'},with:{data:'wrong'}}]};
  const c=await tool('workflow_create',{definition:JSON.stringify(conditionDef)});
  await tool('workflow_publish',{workflow_id:c.workflow_id,expected_revision:1});
  const cr=await tool('workflow_run',{workflow_id:c.workflow_id,inputs:{flag:'false'}});
  ok((await awaitOutcome(cr.run_id)).status==='failed','non-boolean runtime condition fails safely');
  console.log('S1_LOCAL_E2E_PASS',JSON.stringify({assertions:tests,workflow_id:id,run_id:first.run_id,step_count:done.steps.length}));
}finally{await cli.close();}
