import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {compilePlan,toolSchemaDigest} from '../src/plan.ts';
import {reviewedPortalWriteTools,workflowCapabilities} from '../src/capabilities.ts';
import {reviewedWriteArguments,reviewedWriteTool} from '../src/mcp-write-contract.ts';
import {WorkflowService} from '../src/store.ts';
import type {Env} from '../src/store.ts';

const endpoint='https://mcp.lirtual.dpdns.org/mcp';
const schema={type:'object',properties:{content:{type:'string',minLength:1},
  folder_id:{type:'string'},folder_name:{type:'string'}},required:['content'],
  '$schema':'https://json-schema.org/draft/2020-12/schema'};
const upstream={name:'ima_create_note',inputSchema:schema,
  annotations:{readOnlyHint:false,destructiveHint:false}};
const definition=(content='One reviewed note')=>({version:1,name:'Reviewed IMA MCP write',steps:[
  {id:'note',uses:'mcp.call',with:{endpoint,tool:'ima_create_note',scope:'write',
    input_schema:schema,arguments:{content}}},
]});

test('only source-reviewed IMA ima_create_note is discoverable; annotations never grant a new tool',async()=>{
  assert.equal(reviewedWriteTool(upstream),true);
  assert.equal(reviewedWriteTool({...upstream,name:'create_note'}),false);
  assert.equal(reviewedWriteArguments({content:'a note'}),true);
  for(const invalid of [{content:''},{content:'x'.repeat(2049)},
    {content:'hello',folder_id:'sensitive'},{content:{ref:'inputs.message'}},
    {content:'hello',command:'rm'}])
    assert.equal(reviewedWriteArguments(invalid),false);
  for(const candidate of [
    {...upstream,name:'append_note'},
    {...upstream,annotations:{readOnlyHint:true,destructiveHint:false}},
    {...upstream,annotations:{readOnlyHint:false,destructiveHint:true}},
    {...upstream,inputSchema:{...schema,properties:{...schema.properties,command:{type:'string'}}}},
    {...upstream,inputSchema:{...schema,required:['content','folder_name']}},
  ])assert.equal(reviewedWriteTool(candidate),false);
  const allowed=await reviewedPortalWriteTools([upstream]);
  assert.equal(allowed.length,1);
  assert.equal(allowed[0]?.scope,'write');
  assert.deepEqual(allowed[0]?.arguments,{content:'Owner-reviewed note content'});
  assert.deepEqual(await reviewedPortalWriteTools([upstream,upstream]),[]);
  assert.deepEqual(await reviewedPortalWriteTools([{...upstream,name:'append_note'}]),[]);
  const env={MCP_PORTAL_ENDPOINT:endpoint,MCP_PORTAL_CLIENT_ID:'test-id',
    MCP_PORTAL_CLIENT_SECRET:'test-secret'};
  const detail=await workflowCapabilities(env,'action.mcp.write',
    async()=>({availability:'verified_contract' as const,tools:[],write_tools:allowed}));
  assert.equal(detail.availability,'verified_contract');
  assert.equal((detail.example as {validation:string}).validation,'compiler_valid_only');
  const {definition:example,digest}=detail.example as {definition:unknown;digest:string};
  assert.equal((await compilePlan(example)).digest,digest);
  assert.deepEqual((detail.grant as {required:string[]}).required,
    ['approved_operations','approve_mcp_write_execution','accept_target_risks']);
});

test('compiler only admits top-level literal reviewed writes and never a dynamic target or foreach write',async()=>{
  const compiled=await compilePlan(definition());
  assert.equal(compiled.plan.steps[0]?.with.scope,'write');
  assert.equal(compiled.plan.steps[0]?.with.schema_digest,await toolSchemaDigest(schema));
  for(const invalid of [
    {tool:'append_note'},
    {tool:'delete_notes'},
    {arguments:{content:{ref:'inputs.text'}}},
    {arguments:{content:'hello',folder_name:'X'}},
    {arguments:{content:'x'.repeat(2049)}},
    {endpoint:'https://evil.invalid/mcp'},
  ])await assert.rejects(()=>compilePlan({version:1,name:'blocked write',steps:[
    {id:'note',uses:'mcp.call',with:{...definition().steps[0].with,...invalid}},
  ]}));
  await assert.rejects(()=>compilePlan({version:1,name:'no multi write fanout',
    steps:[definition().steps[0],{...definition().steps[0],id:'note_again'}]}),
    /excessive_mcp_write_steps/);
  await assert.rejects(()=>compilePlan({version:1,name:'no foreach write',
    inputs:{items:['a']},steps:[{id:'each',flow:'foreach',max_items:1,
      items:{ref:'inputs.items'},template:{uses:'mcp.call',with:definition().steps[0].with}}]}));
});

function fixture(){
  const sqlite=new DatabaseSync(':memory:');
  for(const file of ['0001_s1.sql','0014_workflow_deletion.sql',
    '0016_portal_connection_revocation.sql','0017_http_connection_auth.sql'])
    sqlite.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  const prepare=(sql:string)=>{
    let args:unknown[]=[];
    return {bind(...v:unknown[]){args=v;return this;},
      async first<T>(){return (sqlite.prepare(sql).get(...args as any[])??null) as T|null;},
      async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...args as any[]).changes)}};},
      async all<T>(){return {results:sqlite.prepare(sql).all(...args as any[]) as T[]};}};
  };
  const db={prepare,async batch(statements:Array<{run:()=>Promise<{meta:{changes:number}}>}>){
    sqlite.exec('BEGIN');try{const results=[];for(const stmt of statements)results.push(await stmt.run());
      sqlite.exec('COMMIT');return results;
    }catch(e){sqlite.exec('ROLLBACK');throw e;}
  }} as unknown as Env['DB'];
  const service=new WorkflowService({DB:db,MCP_PORTAL_ENDPOINT:endpoint} as Env);
  return {sqlite,db,service};
}
const grant=async()=>({endpoint,tool:'ima_create_note',scope:'write' as const,
  schema_digest:await toolSchemaDigest(schema)});
test('write Publish requires exact immutable grant, explicit write approval and risk acceptance',async()=>{
  const {sqlite,service}=fixture();
  try{
    const workflow=await service.create(JSON.stringify(definition()));
    const approval=[await grant()];
    const publishApproved=()=>service.publish(workflow.workflow_id,1,approval,true,false,[],[],[],false,[],false,true);
    const validation=await service.validateDefinition(JSON.stringify(definition()));
    assert.equal(validation.valid,true);
    assert.equal((validation as {requires_mcp_write_execution_approval?:boolean}).requires_mcp_write_execution_approval,true);
    assert.deepEqual((validation as {required_approvals?:unknown}).required_approvals,approval);
    await assert.rejects(()=>service.publish(workflow.workflow_id,1),/external_approval_required/);
    await assert.rejects(()=>service.publish(workflow.workflow_id,1,[{...approval[0],scope:'read'}],true),
      /external_approval_required/);
    await assert.rejects(()=>service.publish(workflow.workflow_id,1,approval,true),
      /mcp_write_approval_required/);
    await assert.rejects(()=>service.publish(workflow.workflow_id,1,approval,false,false,[],[],[],false,[],false,true),
      /target_risk_acknowledgment_required/);
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM workflow_versions').get()?.n,0);
    const published=await publishApproved();
    const saved=sqlite.prepare('SELECT plan FROM workflow_versions WHERE id=?')
      .get(published.published_version_id) as {plan:string};
    const pinned=JSON.parse(saved.plan);
    assert.deepEqual(pinned.mcp_approvals,approval);
    assert.equal(pinned.mcp_write_execution_approved,true);
    assert.equal(pinned.mcp_connection_generation,0);
    assert.equal((await publishApproved()).published_version_id,published.published_version_id);
    await service.portalConnectionRevoke();
    await assert.rejects(()=>publishApproved(),/portal_connection_revoked/);
    await service.portalConnectionEnable();
    const newVersion=await publishApproved();
    assert.notEqual(newVersion.published_version_id,published.published_version_id);
    assert.equal(JSON.parse(String((sqlite.prepare('SELECT plan FROM workflow_versions WHERE id=?')
      .get(newVersion.published_version_id) as {plan:string}).plan)).mcp_connection_generation,1);
  }finally{sqlite.close();}
});
