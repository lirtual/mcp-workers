import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyMcpNoDispatchEvidence,verifyPriorMcpNoDispatchProof,EIGHTH_MCP_RUN_ID} from './workflow-mcp-no-dispatch-proof.mjs';

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

const PRIOR_RELEASE_ID=41451130475;
const PRIOR_SHA='4c422150237d50f67210c75e39a4ef1fc0b53a6c';
function priorSuccess(){
  return {run:{id:PRIOR_RELEASE_ID,workflow_id:394912681,head_branch:'main',
    head_sha:PRIOR_SHA,event:'workflow_dispatch',run_attempt:1,
    status:'completed',conclusion:'success'},
  jobs:{jobs:[{id:125296945646,run_id:PRIOR_RELEASE_ID,
    name:'Manual selected Worker release',head_sha:PRIOR_SHA,
    run_attempt:1,status:'completed',conclusion:'success',
    steps:[{name:'Verify eighth MCP no-dispatch Run proof (read-only)',
      number:23,status:'completed',conclusion:'success'}]}]}};
}

test('only exact prior successful run, job, SHA and eighth step prove expired native',()=>{
  const {run,jobs}=priorSuccess();
  const signed=verifyPriorMcpNoDispatchProof(run,jobs);
  assert.equal(verifyMcpNoDispatchEvidence(sample().d1,signed),runId);
  for(const [key,value] of [
    ['id',41451130474],['workflow_id',123],['head_sha','0'.repeat(40)],
    ['head_branch','other'],['event','push'],['run_attempt',2],
    ['status','in_progress'],['conclusion','failure']]){
    const p=structuredClone(priorSuccess());p.run[key]=value;
    assert.throws(()=>verifyPriorMcpNoDispatchProof(p.run,p.jobs),/blocked/);
  }
  for(const [key,value] of [
    ['id',12],['run_id',123],['name','wrong'],['head_sha','1'.repeat(40)],
    ['run_attempt',2],['status','in_progress'],['conclusion','failure']]){
    const p=structuredClone(priorSuccess());p.jobs.jobs[0][key]=value;
    assert.throws(()=>verifyPriorMcpNoDispatchProof(p.run,p.jobs),/blocked/);
  }
  for(const [key,value] of [
    ['name','Wrong step'],['number',22],['status','queued'],['conclusion','failure']]){
    const p=structuredClone(priorSuccess());p.jobs.jobs[0].steps[0][key]=value;
    assert.throws(()=>verifyPriorMcpNoDispatchProof(p.run,p.jobs),/blocked/);
  }
  const dup=priorSuccess();dup.jobs.jobs[0].steps.push({...dup.jobs.jobs[0].steps[0]});
  assert.throws(()=>verifyPriorMcpNoDispatchProof(dup.run,dup.jobs),/blocked/);
  assert.throws(()=>verifyMcpNoDispatchEvidence(sample().d1,{}),/blocked/);
});

test('a pinned prior native proof never overrides changed D1 or a dispatch fence',()=>{
  const {run,jobs}=priorSuccess();
  const native=verifyPriorMcpNoDispatchProof(run,jobs);
  for(const [idx,key,value] of [
    [0,'outcome','succeeded'],[0,'version_id','wrong'],
    [1,'status','succeeded'],[1,'step_id','other']]){
    const bad=sample();bad.d1[idx].results[0][key]=value;
    assert.throws(()=>verifyMcpNoDispatchEvidence(bad.d1,native),/blocked/);
  }
  const sent=sample();sent.d1[2].results.push({run_id:runId,step_id:'create_note'});
  assert.throws(()=>verifyMcpNoDispatchEvidence(sent.d1,native),/blocked/);
  const sess=sample();sess.d1[3].results.push({run_id:runId,state:'ready'});
  assert.throws(()=>verifyMcpNoDispatchEvidence(sess.d1,native),/blocked/);
  const other=sample();other.d1[4].results[0].id='incorrect';
  assert.throws(()=>verifyMcpNoDispatchEvidence(other.d1,native),/blocked/);
});

test('#1046 carries exact no-dispatch terminal fact without rewriting a running Step',async()=>{
  const {historicalMcpNoDispatchTerminalProof}=await import('./workflow-mcp-no-dispatch-proof.mjs');
  const {verifyWorkflowTerminalEvidence}=await import('./manual-worker-release.mjs');
  const {run,jobs}=priorSuccess();
  jobs.jobs[0].steps[0].completed_at='2026-11-02T13:15:36Z';
  const {d1}=sample();
  const r=d1[0].results[0];r.instance_id=r.id;
  const evidence={steps:d1[1].results,attempts:[],sessions:[],callbacks:[],children:[],
    invocations:[],mcpFences:[],githubCancellations:[],cloudflareCancellations:[],
    childCancellations:[],gates:[],approvals:[],waits:[]};
  const proof=historicalMcpNoDispatchTerminalProof(d1,run,jobs);
  assert.equal(proof.observed_at,Date.parse('2026-11-02T13:15:36Z'));
  assert.deepEqual(verifyWorkflowTerminalEvidence(r,proof,evidence),proof);
  assert.equal(r.outcome,'indeterminate');
  assert.equal(evidence.steps[0].status,'running');
  const {no_dispatch_step_id,...native}=proof;
  assert.throws(()=>verifyWorkflowTerminalEvidence(r,native,evidence),/terminal evidence/);
  assert.throws(()=>verifyWorkflowTerminalEvidence(r,{...proof,status:'complete'},evidence),/terminal evidence/);
  assert.throws(()=>verifyWorkflowTerminalEvidence(r,{...proof,no_dispatch_step_id:'other'},evidence),/terminal evidence/);
  for(const bad of [
    {...evidence,mcpFences:[{run_id:r.id,step_id:'create_note'}]},
    {...evidence,steps:[{...evidence.steps[0],status:'succeeded'}]},
    {...evidence,steps:[...evidence.steps,{run_id:r.id,step_id:'other',status:'running'}]},
    {...evidence,invocations:[{run_id:r.id,step_id:'create_note'}]},
  ]) assert.throws(()=>verifyWorkflowTerminalEvidence(r,proof,bad),/terminal evidence/);
  const changed=structuredClone(d1);changed[2].results.push({run_id:r.id,step_id:'create_note'});
  assert.throws(()=>historicalMcpNoDispatchTerminalProof(changed,run,jobs),/blocked/);
});
