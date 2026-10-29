import test from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import { verifyTerminalRunEvidence, verifySecondTerminalEvidence, verifyThirdTerminalEvidence, verifyFourthTerminalEvidence, verifyFifthTerminalEvidence, verifySixthTerminalEvidence, verifyPriorNativeProof, TERMINAL_RUN_ID, SECOND_TERMINAL_RUN_ID, THIRD_TERMINAL_RUN_ID, FOURTH_TERMINAL_RUN_ID, FIFTH_TERMINAL_RUN_ID, SIXTH_TERMINAL_RUN_ID } from "./workflow-terminal-run-exception.mjs";

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
    WORKFLOW_SECOND_TERMINAL_RUN_ID:SECOND_TERMINAL_RUN_ID,
    WORKFLOW_THIRD_TERMINAL_RUN_ID:THIRD_TERMINAL_RUN_ID,
     WORKFLOW_FOURTH_TERMINAL_RUN_ID:FOURTH_TERMINAL_RUN_ID,
     WORKFLOW_FIFTH_TERMINAL_RUN_ID:FIFTH_TERMINAL_RUN_ID,
     WORKFLOW_SIXTH_TERMINAL_RUN_ID:SIXTH_TERMINAL_RUN_ID
  }});
  assert.equal((withBoth.match(new RegExp(SECOND_TERMINAL_RUN_ID,"g"))||[]).length,2);
  assert.match(withBoth,/run_id NOT IN/);
  assert.equal((withBoth.match(new RegExp(THIRD_TERMINAL_RUN_ID,"g"))||[]).length,2);
  assert.equal((withBoth.match(new RegExp(FOURTH_TERMINAL_RUN_ID,"g"))||[]).length,2);
  assert.equal((withBoth.match(new RegExp(FIFTH_TERMINAL_RUN_ID,"g"))||[]).length,2);
  assert.equal((withBoth.match(new RegExp(SIXTH_TERMINAL_RUN_ID,"g"))||[]).length,2);
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
  assert.equal((release.match(/steps\.terminal_third\.outputs\.third_terminal_run_id/g)||[]).length,3);
  assert.equal((release.match(/id <> '\$WORKFLOW_THIRD_TERMINAL_RUN_ID'/g)||[]).length,2);
  assert.equal((release.match(/steps\.terminal_fourth\.outputs\.fourth_terminal_run_id/g)||[]).length,3);
  assert.equal((release.match(/id <> '\$WORKFLOW_FOURTH_TERMINAL_RUN_ID'/g)||[]).length,2);
  assert.ok(release.indexOf("Verify fourth terminal E2E Run proof")<
    release.indexOf("Verify Workflow release configuration"));
  assert.equal((release.match(/steps\.terminal_fifth\.outputs\.fifth_terminal_run_id/g)||[]).length,3);
  assert.equal((release.match(/id <> '\$WORKFLOW_FIFTH_TERMINAL_RUN_ID'/g)||[]).length,2);
  assert.ok(release.indexOf("Verify fifth terminal E2E Run proof")<
    release.indexOf("Verify Workflow release configuration"));
  assert.equal((release.match(/steps\.terminal_sixth\.outputs\.sixth_terminal_run_id/g)||[]).length,3);
  assert.equal((release.match(/id <> '\$WORKFLOW_SIXTH_TERMINAL_RUN_ID'/g)||[]).length,2);
  assert.ok(release.indexOf("Verify sixth terminal E2E Run proof")<
    release.indexOf("Verify Workflow release configuration"));
  assert.ok(release.indexOf("Verify third terminal E2E Run proof")<
    release.indexOf("Verify Workflow release configuration"));
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

test("third exact Owner-delivered Run: immutable unknown result and independent physical termination",()=>{
 const id=THIRD_TERMINAL_RUN_ID;
 const data={
  d1:[
   {success:true,results:[{id,outcome:"indeterminate",start_state:"started",error_code:"cloudflare_outcome_unknown"}]},
   {success:true,results:[
    {run_id:id,step_id:"notify",status:"indeterminate",error_code:"cloudflare_outcome_unknown"},
    {run_id:id,step_id:"openlist",status:"succeeded",error_code:null},
    {run_id:id,step_id:"receipt",status:"skipped",error_code:null}]},
   {success:true,results:[{run_id:id,step_id:"openlist",state:"terminated"}]},
   {success:true,results:[{run_id:id,step_id:"openlist",state:"cancelled",
    repository:"lirtual/session-actions",owner_run_id:40722496262,owner_run_attempt:1,
    candidate_run_id:40722496262,candidate_run_attempt:1}]},
   {success:true,results:[{run_id:id,step_id:"notify",
    invocation_id:"223af10e-dcf4-48c3-8c06-a39e60fa758b",
    binding_generation:1,deployment_id:"8df4f696-2f04-4043-9123-285c7aa86b0d"}]}
  ],
  native:{status:"complete",end:"2026-10-28T16:13:39.019Z"},
  github:{id:40722496262,status:"completed",conclusion:"cancelled"}
 };
 assert.equal(verifyThirdTerminalEvidence(data.d1,data.native,data.github),id);
 for(const [group,key,bad] of [
  [0,"outcome","succeeded"],[0,"error_code",null],
  [1,"status","succeeded"],[2,"state","ready"],
  [3,"state","claimed"],[3,"candidate_run_id",42],
  [4,"invocation_id","replaced"],[4,"binding_generation",2],
  [4,"deployment_id","wrong-version"]]){
  const changed=structuredClone(data);changed.d1[group].results[0][key]=bad;
  assert.throws(()=>verifyThirdTerminalEvidence(changed.d1,changed.native,changed.github),/blocked/);
 }
 for(const patch of [{status:"running"},{end:null}])
  assert.throws(()=>verifyThirdTerminalEvidence(data.d1,{...data.native,...patch},data.github),/blocked/);
 for(const patch of [{status:"in_progress"},{conclusion:"success"},{id:5}])
  assert.throws(()=>verifyThirdTerminalEvidence(data.d1,data.native,{...data.github,...patch}),/blocked/);
 const extra=structuredClone(data);extra.d1[4].results.push({...extra.d1[4].results[0]});
 assert.throws(()=>verifyThirdTerminalEvidence(extra.d1,extra.native,extra.github),/blocked/);
});

test("fourth exact Owner-delivered Run: immutable unknown result and independent physical termination",()=>{
 const id=FOURTH_TERMINAL_RUN_ID;
 const data={
  d1:[
   {success:true,results:[{id,outcome:"indeterminate",start_state:"started",error_code:"cloudflare_outcome_unknown"}]},
   {success:true,results:[
    {run_id:id,step_id:"notify",status:"indeterminate",error_code:"cloudflare_outcome_unknown"},
    {run_id:id,step_id:"openlist",status:"succeeded",error_code:null},
    {run_id:id,step_id:"receipt",status:"skipped",error_code:null}]},
   {success:true,results:[{run_id:id,step_id:"openlist",state:"terminated"}]},
   {success:true,results:[{run_id:id,step_id:"openlist",state:"cancelled",
    repository:"lirtual/session-actions",owner_run_id:40792650738,owner_run_attempt:1,
    candidate_run_id:40792650738,candidate_run_attempt:1}]},
   {success:true,results:[{run_id:id,step_id:"notify",
    invocation_id:"27cf5b0e-3b9c-4d9f-a9bd-db76c2266ea5",
    binding_generation:1,deployment_id:"12970996-4220-4731-b76e-a0c8aa7a5017"}]}
  ],
  native:{status:"complete",end:"2026-10-29T00:19:28.947Z"},
  github:{id:40792650738,status:"completed",conclusion:"cancelled"}
 };
 assert.equal(verifyFourthTerminalEvidence(data.d1,data.native,data.github),id);
 for(const [group,key,bad] of [
  [0,"outcome","succeeded"],[0,"error_code",null],
  [1,"status","succeeded"],[2,"state","ready"],
  [3,"state","claimed"],[3,"candidate_run_id",42],
  [4,"invocation_id","replaced"],[4,"binding_generation",2],
  [4,"deployment_id","wrong-version"]]){
  const changed=structuredClone(data);changed.d1[group].results[0][key]=bad;
  assert.throws(()=>verifyFourthTerminalEvidence(changed.d1,changed.native,changed.github),/blocked/);
 }
 for(const patch of [{status:"running"},{end:null}])
  assert.throws(()=>verifyFourthTerminalEvidence(data.d1,{...data.native,...patch},data.github),/blocked/);
 for(const patch of [{status:"in_progress"},{conclusion:"success"},{id:5}])
  assert.throws(()=>verifyFourthTerminalEvidence(data.d1,data.native,{...data.github,...patch}),/blocked/);
 const extra=structuredClone(data);extra.d1[4].results.push({...extra.d1[4].results[0]});
 assert.throws(()=>verifyFourthTerminalEvidence(extra.d1,extra.native,extra.github),/blocked/);
});

test("fifth exact Owner-delivered Run: immutable unknown result and independent physical termination",()=>{
 const id=FIFTH_TERMINAL_RUN_ID;
 const data={
  d1:[
   {success:true,results:[{id,outcome:"indeterminate",start_state:"started",error_code:"cloudflare_outcome_unknown"}]},
   {success:true,results:[
    {run_id:id,step_id:"notify",status:"indeterminate",error_code:"cloudflare_outcome_unknown"},
    {run_id:id,step_id:"openlist",status:"succeeded",error_code:null},
    {run_id:id,step_id:"receipt",status:"skipped",error_code:null}]},
   {success:true,results:[{run_id:id,step_id:"openlist",state:"terminated"}]},
   {success:true,results:[{run_id:id,step_id:"openlist",state:"cancelled",
    repository:"lirtual/session-actions",owner_run_id:40803663333,owner_run_attempt:1,
    candidate_run_id:40803663333,candidate_run_attempt:1}]},
   {success:true,results:[{run_id:id,step_id:"notify",
    invocation_id:"2adf4608-c075-425d-a93d-d7d74211a295",
    binding_generation:1,deployment_id:"3d61997c-eb30-46e3-b96f-334343d061af"}]}
  ],
  native:{status:"complete",end:"2026-10-29T02:07:34.402Z"},
  github:{id:40803663333,status:"completed",conclusion:"cancelled"}
 };
 assert.equal(verifyFifthTerminalEvidence(data.d1,data.native,data.github),id);
 for(const [group,key,bad] of [
  [0,"outcome","succeeded"],[0,"error_code",null],
  [1,"status","succeeded"],[2,"state","ready"],
  [3,"state","claimed"],[3,"candidate_run_id",42],
  [4,"invocation_id","replaced"],[4,"binding_generation",2],
  [4,"deployment_id","wrong-version"]]){
  const changed=structuredClone(data);changed.d1[group].results[0][key]=bad;
  assert.throws(()=>verifyFifthTerminalEvidence(changed.d1,changed.native,changed.github),/blocked/);
 }
 for(const patch of [{status:"running"},{end:null}])
  assert.throws(()=>verifyFifthTerminalEvidence(data.d1,{...data.native,...patch},data.github),/blocked/);
 for(const patch of [{status:"in_progress"},{conclusion:"success"},{id:5}])
  assert.throws(()=>verifyFifthTerminalEvidence(data.d1,data.native,{...data.github,...patch}),/blocked/);
 const extra=structuredClone(data);extra.d1[4].results.push({...extra.d1[4].results[0]});
 assert.throws(()=>verifyFifthTerminalEvidence(extra.d1,extra.native,extra.github),/blocked/);
});

test("sixth exact Owner-delivered Run: immutable unknown result and independent physical termination",()=>{
 const id=SIXTH_TERMINAL_RUN_ID;
 const data={
  d1:[
   {success:true,results:[{id,outcome:"indeterminate",start_state:"started",error_code:"cloudflare_outcome_unknown"}]},
   {success:true,results:[
    {run_id:id,step_id:"notify",status:"indeterminate",error_code:"cloudflare_outcome_unknown"},
    {run_id:id,step_id:"openlist",status:"succeeded",error_code:null},
    {run_id:id,step_id:"receipt",status:"skipped",error_code:null}]},
   {success:true,results:[{run_id:id,step_id:"openlist",state:"terminated"}]},
   {success:true,results:[{run_id:id,step_id:"openlist",state:"cancelled",
    repository:"lirtual/session-actions",owner_run_id:40806497790,owner_run_attempt:1,
    candidate_run_id:40806497790,candidate_run_attempt:1}]},
   {success:true,results:[{run_id:id,step_id:"notify",
    invocation_id:"83b722f0-4ed3-4a7d-838c-78613f5167f1",
    binding_generation:1,deployment_id:"aeed581e-2769-4cde-9f6a-236d6414b4a2"}]}
  ],
  native:{status:"complete",end:"2026-10-29T02:36:14.759Z"},
  github:{id:40806497790,status:"completed",conclusion:"cancelled"}
 };
 assert.equal(verifySixthTerminalEvidence(data.d1,data.native,data.github),id);
 for(const [group,key,bad] of [
  [0,"outcome","succeeded"],[0,"error_code",null],
  [1,"status","succeeded"],[2,"state","ready"],
  [3,"state","claimed"],[3,"candidate_run_id",42],
  [4,"invocation_id","replaced"],[4,"binding_generation",2],
  [4,"deployment_id","wrong-version"]]){
  const changed=structuredClone(data);changed.d1[group].results[0][key]=bad;
  assert.throws(()=>verifySixthTerminalEvidence(changed.d1,changed.native,changed.github),/blocked/);
 }
 for(const patch of [{status:"running"},{end:null}])
  assert.throws(()=>verifySixthTerminalEvidence(data.d1,{...data.native,...patch},data.github),/blocked/);
 for(const patch of [{status:"in_progress"},{conclusion:"success"},{id:5}])
  assert.throws(()=>verifySixthTerminalEvidence(data.d1,data.native,{...data.github,...patch}),/blocked/);
 const extra=structuredClone(data);extra.d1[4].results.push({...extra.d1[4].results[0]});
 assert.throws(()=>verifySixthTerminalEvidence(extra.d1,extra.native,extra.github),/blocked/);
});

// Cloudflare can return 404 for a formerly completed instance. Only the
// exact successful, identity-pinned release with all six proof steps may
// recover this historical evidence; no fake status/end timestamp is used.
test("only previously audited immutable Release proves expired native history",()=>{
  const head="85464b14040e174f3ea43f6e4acd92b29c523563";
  const run={id:40871993462,workflow_id:394912681,head_sha:head,
    event:"workflow_dispatch",status:"completed",conclusion:"success"};
  const names=["Verify historical terminal Run proof (read-only)",
    "Verify second terminal E2E Run proof (read-only)",
    "Verify third terminal E2E Run proof (read-only)",
    "Verify fourth terminal E2E Run proof (read-only)",
    "Verify fifth terminal E2E Run proof (read-only)",
    "Verify sixth terminal E2E Run proof (read-only)"];
  const jobs={jobs:[{id:123441577953,name:"Manual selected Worker release",
    status:"completed",conclusion:"success",head_sha:head,
    steps:names.map(name=>({name,conclusion:"success"}))}]};
  const certified=verifyPriorNativeProof(run,jobs);
  assert.equal(verifyTerminalRunEvidence(ok().d1,certified,ok().github),TERMINAL_RUN_ID);
  for(const patch of [{id:2},{head_sha:"0".repeat(40)},
    {workflow_id:123},{event:"push"},{conclusion:"failure"},{status:"in_progress"}])
    assert.throws(()=>verifyPriorNativeProof({...run,...patch},jobs),/blocked/);
  for(const patch of [{id:5},{head_sha:"0".repeat(40)},
    {status:"queued"},{conclusion:"failure"},{name:"untrusted release"}]){
    const bad=structuredClone(jobs);Object.assign(bad.jobs[0],patch);
    assert.throws(()=>verifyPriorNativeProof(run,bad),/blocked/);
  }
  for(let i=0;i<names.length;i++){
    const bad=structuredClone(jobs);bad.jobs[0].steps[i].conclusion="skipped";
    assert.throws(()=>verifyPriorNativeProof(run,bad),/blocked/);
  }
  assert.throws(()=>verifyPriorNativeProof(run,{jobs:[]}),/blocked/);
  assert.throws(()=>verifyTerminalRunEvidence(ok().d1,{previously_verified_release:40871993462},ok().github),/blocked/);
});
