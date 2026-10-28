import test from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import { verifyTerminalRunEvidence, verifySecondTerminalEvidence, TERMINAL_RUN_ID, SECOND_TERMINAL_RUN_ID } from "./workflow-terminal-run-exception.mjs";

const ok = () => ({
  d1:[
    {success:true,results:[{id:TERMINAL_RUN_ID,outcome:"indeterminate",start_state:"started",error_code:"github_session_no_ready"}]},
    {success:true,results:[{run_id:TERMINAL_RUN_ID,step_id:"openlist_session",status:"indeterminate",error_code:"github_session_no_ready"}]},
    {success:true,results:[{run_id:TERMINAL_RUN_ID,step_id:"openlist_session",state:"terminated"}]},
    {success:true,results:[{run_id:TERMINAL_RUN_ID,step_id:"openlist_session",state:"cancelled",
      repository:"lirtual/session-actions",owner_run_id:40324650847,owner_run_attempt:1,
      candidate_run_id:40324650847,candidate_run_attempt:1}]}
  ],
  native:{status:"complete",end:"2026-10-26T12:44:56Z"},
  github:{id:40324650847,status:"completed",conclusion:"cancelled"}
});
test("one exact historical Run requires D1 + Cloudflare + GitHub terminal proofs",()=>{
  const {d1,native,github}=ok();
  assert.equal(verifyTerminalRunEvidence(d1,native,github),TERMINAL_RUN_ID);
  for(const [group,field,bad] of [[0,"outcome","succeeded"],[0,"id","ffffffff-ffff-ffff-ffff-ffffffffffff"],
    [1,"status","succeeded"],[2,"state","ready"],[3,"state","claimed"],[3,"owner_run_id",1234],[3,"owner_run_attempt",2]]) {
    const sample=ok();sample.d1[group].results[0][field]=bad;
    assert.throws(()=>verifyTerminalRunEvidence(sample.d1,sample.native,sample.github),/blocked/);
  }
  for(const patch of [{status:"running"},{end:null}])
    assert.throws(()=>verifyTerminalRunEvidence(d1,{...native,...patch},github),/blocked/);
  for(const patch of [{conclusion:"success"},{status:"in_progress"},{id:3}])
    assert.throws(()=>verifyTerminalRunEvidence(d1,native,{...github,...patch}),/blocked/);
  const noSession=ok();noSession.d1[2].results=[];
  assert.throws(()=>verifyTerminalRunEvidence(noSession.d1,native,github),/blocked/);
});

test("SQL exception is explicit for one proven Run; all new Session/Run counters remain guarded",()=>{
  const args=["scripts/manual-worker-release.mjs","migration-sql","workflow-mcp-worker"];
  const plain=execFileSync(process.execPath,args,{encoding:"utf8",env:{
    ...process.env,WORKFLOW_TERMINAL_RUN_ID:""
  }});
  const scoped=execFileSync(process.execPath,args,{encoding:"utf8",env:{
    ...process.env,WORKFLOW_TERMINAL_RUN_ID:TERMINAL_RUN_ID
  }});
  const invented=execFileSync(process.execPath,args,{encoding:"utf8",env:{
    ...process.env,WORKFLOW_TERMINAL_RUN_ID:"ffffffff-ffff-ffff-ffff-ffffffffffff"
  }});
  assert.equal(plain,invented);
  assert.notEqual(scoped,plain);
  assert.match(scoped,/nonterminal_runs/);
  assert.match(scoped,/unresolved_steps/);
  assert.match(scoped,/nonterminated_sessions/);
  assert.match(scoped,/nonterminal_attempts/);
  assert.equal((scoped.match(new RegExp(TERMINAL_RUN_ID,"g"))||[]).length,2);
  const withBoth=execFileSync(process.execPath,args,{encoding:"utf8",env:{
    ...process.env,WORKFLOW_TERMINAL_RUN_ID:TERMINAL_RUN_ID,
    WORKFLOW_SECOND_TERMINAL_RUN_ID:SECOND_TERMINAL_RUN_ID
  }});
  assert.equal((withBoth.match(new RegExp(SECOND_TERMINAL_RUN_ID,"g"))||[]).length,2);
  assert.match(withBoth,/run_id NOT IN/);
  const forged=execFileSync(process.execPath,args,{encoding:"utf8",env:{
    ...process.env,WORKFLOW_TERMINAL_RUN_ID:TERMINAL_RUN_ID,
    WORKFLOW_SECOND_TERMINAL_RUN_ID:"ffffffff-ffff-ffff-ffff-ffffffffffff"
  }});
  assert.equal(scoped,forged);
  const release=readFileSync(".github/workflows/release.yml","utf8");
  assert.ok(release.indexOf("Verify historical terminal Run proof")<
    release.indexOf("Verify Workflow release configuration"));
  assert.ok(release.indexOf("Verify historical terminal Run proof")<
    release.indexOf("Apply complete Workflow D1 migrations"));
  assert.equal((release.match(/steps\.terminal\.outputs\.terminal_run_id/g)||[]).length,3);
  assert.equal((release.match(/id <> '\$WORKFLOW_TERMINAL_RUN_ID'/g)||[]).length,2);
  assert.equal((release.match(/id <> '\$WORKFLOW_SECOND_TERMINAL_RUN_ID'/g)||[]).length,2);
  assert.equal((release.match(/steps\.terminal_second\.outputs\.second_terminal_run_id/g)||[]).length,3);
  assert.ok(release.indexOf("Verify second terminal E2E Run proof")<
    release.indexOf("Verify Workflow release configuration"));
});

test("second terminal owner-delivered unknown keeps D1 business outcome and proves all physical stops",()=>{
  const id=SECOND_TERMINAL_RUN_ID;
  const evidence={
    d1:[
      {success:true,results:[{id,outcome:"indeterminate",start_state:"started",error_code:"cloudflare_outcome_unknown"}]},
      {success:true,results:[
        {run_id:id,step_id:"notify",status:"indeterminate",error_code:"cloudflare_outcome_unknown"},
        {run_id:id,step_id:"openlist",status:"succeeded",error_code:null}
      ]},
      {success:true,results:[{run_id:id,step_id:"openlist",state:"terminated"}]},
      {success:true,results:[{run_id:id,step_id:"openlist",state:"cancelled",repository:"lirtual/session-actions",
        owner_run_id:40654886218,candidate_run_id:40654886218,owner_run_attempt:1,candidate_run_attempt:1}]},
      {success:true,results:[{run_id:id,step_id:"notify",
        invocation_id:"2a7527ef-23d1-472d-b369-74c29a31c443",
        binding_generation:1,deployment_id:"a2faea6a-dc64-40cb-b6fd-91bf7f306f9b"}]}
    ],
    native:{status:"complete",end:"2026-10-28T08:18:25Z"},
    github:{id:40654886218,status:"completed",conclusion:"cancelled"}
  };
  assert.equal(verifySecondTerminalEvidence(evidence.d1,evidence.native,evidence.github),id);
  for(const [group,key,bad] of [[0,"outcome","succeeded"],[1,"status","succeeded"],
    [2,"state","ready"],[3,"state","claimed"],[3,"candidate_run_id",3],
    [4,"invocation_id","not-matching"],[4,"binding_generation",2]]){
    const clone=structuredClone(evidence);
    clone.d1[group].results[0][key]=bad;
    assert.throws(()=>verifySecondTerminalEvidence(clone.d1,clone.native,clone.github),/blocked/);
  }
  for(const patch of [{status:"running"},{end:null}])
    assert.throws(()=>verifySecondTerminalEvidence(evidence.d1,{...evidence.native,...patch},evidence.github),/blocked/);
  for(const patch of [{status:"in_progress"},{conclusion:"success"},{id:4}])
    assert.throws(()=>verifySecondTerminalEvidence(evidence.d1,evidence.native,{...evidence.github,...patch}),/blocked/);
  const extra=structuredClone(evidence);extra.d1[4].results.push({...extra.d1[4].results[0]});
  assert.throws(()=>verifySecondTerminalEvidence(extra.d1,extra.native,extra.github),/blocked/);
});
