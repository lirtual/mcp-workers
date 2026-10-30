import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {verifyMcpNoDispatchEvidence,EIGHTH_MCP_RUN_ID} from './workflow-mcp-no-dispatch-proof.mjs';

const runId=EIGHTH_MCP_RUN_ID;
function sample(){
  const plan={version:1,name:'Spec176 write test',steps:[{id:'create_note',uses:'mcp.call',
    with:{endpoint:'https://mcp.lirtual.dpdns.org/mcp',tool:'ima_create_note',scope:'write',
      arguments:{content:'Spec #176 · One-time Workflow MCP write production E2E'}}}],
    mcp_write_execution_approved:true};
  const d1=[
    [{id:runId,workflow_id:'1e070f56-b5a4-43e6-8671-670d120740b4',
      version_id:'30a01b13-8a94-48d8-b349-dba2ec4dced4',outcome:'indeterminate',
      start_state:'started',error_code:'execution_interrupted'}],
    [{run_id:runId,step_id:'create_note',status:'running',error_code:null}],
    [],[],
    [{id:'30a01b13-8a94-48d8-b349-dba2ec4dced4',plan:JSON.stringify(plan)}],
  ].map(results=>({success:true,results}));
  const native={status:'errored',end:'2026-10-30T14:17:17.111Z',step_count:1,
    error:{name:'Error',message:'execution_interrupted'},steps:[{
      name:'workflow-create_note-1',success:false,
      config:{timeout:'30 seconds',retries:{limit:0}},
      attempts:[{success:false,error:{name:'WorkflowTimeoutError',
        message:'Execution timed out after 30000ms'}}],
    }]};
  return {d1,native};
}

test('only the pinned failed MCP Run with zero dispatch fence is exempted',()=>{
  const {d1,native}=sample();
  assert.equal(verifyMcpNoDispatchEvidence(d1,native),runId);
  for(const [group,key,value] of [
    [0,'id','ffffffff-ffff-ffff-ffff-ffffffffffff'],[0,'outcome','succeeded'],
    [0,'error_code',null],[1,'status','succeeded'],[1,'step_id','other'],
  ]){
    const bad=structuredClone(sample());bad.d1[group].results[0][key]=value;
    assert.throws(()=>verifyMcpNoDispatchEvidence(bad.d1,bad.native),/blocked/);
  }
  const dispatched=sample();dispatched.d1[2].results.push({run_id:runId,step_id:'create_note'});
  assert.throws(()=>verifyMcpNoDispatchEvidence(dispatched.d1,dispatched.native),/blocked/);
  const session=sample();session.d1[3].results.push({run_id:runId,step_id:'create_note',state:'ready'});
  assert.throws(()=>verifyMcpNoDispatchEvidence(session.d1,session.native),/blocked/);
  for(const patch of [{status:'running'},{end:null},{step_count:2},
    {steps:[{...native.steps[0],attempts:[native.steps[0].attempts[0],native.steps[0].attempts[0]]}]},
    {steps:[{...native.steps[0],config:{timeout:'90 seconds',retries:{limit:0}}}]},
  ])assert.throws(()=>verifyMcpNoDispatchEvidence(d1,{...native,...patch}),/blocked/);
  const altered=sample();const v=JSON.parse(altered.d1[4].results[0].plan);
  v.steps[0].with.tool='other';altered.d1[4].results[0].plan=JSON.stringify(v);
  assert.throws(()=>verifyMcpNoDispatchEvidence(altered.d1,altered.native),/blocked/);
});

test('release only excludes the exact eighth Run after independent proof output',()=>{
  const env={...process.env,WORKFLOW_EIGHTH_TERMINAL_RUN_ID:runId};
  const get=(overrides={})=>execFileSync(process.execPath,
    ['scripts/manual-worker-release.mjs','migration-sql','workflow-mcp-worker'],
    {encoding:'utf8',env:{...env,...overrides}});
  const granted=get(),unknown=get({WORKFLOW_EIGHTH_TERMINAL_RUN_ID:'ffffffff-ffff-ffff-ffff-ffffffffffff'});
  assert.equal((granted.match(new RegExp(runId,'g'))||[]).length,2);
  assert.equal((unknown.match(new RegExp(runId,'g'))||[]).length,0);
  const workflow=readFileSync('.github/workflows/release.yml','utf8');
  assert.equal(workflow.split('steps.terminal_eighth.outputs.eighth_terminal_run_id').length-1,3);
  assert.equal(workflow.split("id <> '$WORKFLOW_EIGHTH_TERMINAL_RUN_ID'").length-1,2);
  assert.ok(workflow.indexOf('Verify eighth MCP no-dispatch Run proof')<
    workflow.indexOf('Verify Workflow release configuration'));
});
