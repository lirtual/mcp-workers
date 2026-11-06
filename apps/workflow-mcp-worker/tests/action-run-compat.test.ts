import test from "node:test";
import assert from "node:assert/strict";
import {compilePlan,compilePublicPlan} from "../src/plan.ts";
const action={repository:"lirtual/github-actions",repositoryId:101,workflowId:202,
  workflowPath:".github/workflows/linux.yml",commitSha:"a".repeat(40),
  type:"session",contractDigest:"b".repeat(64),ref:"refs/tags/v1",inputs:{duration_minutes:5}};
const draft=(uses:string,withData:unknown)=>({version:1,name:"Unified Action",steps:[{id:"session",uses,with:withData}]});
test("new GitHub action.run compiles into unchanged reviewed internal GitHub executor contract",async()=>{
 const next=await compilePlan(draft("action.run",{executor:"github",capability:"github.action",action}));
 assert.equal(next.plan.steps[0]!.uses,"github.run");
 assert.deepEqual(next.plan.steps[0]!.with,{capability:"github.action",action});
 assert.equal(next.plan.github_execution_approved,undefined);
});
test("unreviewed Cloudflare executor, dynamic target and unpinned GitHub identity fail closed",async()=>{
 for(const withData of [
  {executor:"cloudflare",action:"weixin.send_text",inputs:{session_url:"https://x.trycloudflare.com/"}},
  {executor:"https://attacker.example",capability:"github.action",action},
  {executor:"github",capability:"github.shell",action},
  {executor:"github",capability:"github.action",action:{...action,commitSha:"main"}},
  {executor:"github",capability:"github.action",action,service_binding:"arbitrary"},
 ]) await assert.rejects(compilePlan(draft("action.run",withData)));
});
test("new GitHub Task syntax keeps bounded foreach snapshot identities and digest",async()=>{
 const task={...action,type:"task",inputs:{duration_minutes:5}};
 const source=(use:string,withData:unknown)=>({version:1,name:"Mapped Task",steps:[
  {id:"batch",flow:"foreach",items:{ref:"inputs.items"},max_items:2,
   template:{steps:[{id:"exec",uses:use,with:withData}]}},
 ]});
 const unified=await compilePlan(source("action.run",{executor:"github",capability:"github.action",action:task}));
 assert.equal(unified.plan.steps[0]!.uses,"flow.foreach");
 assert.equal((unified.plan.steps[0]!.with.template as {uses:string}).uses,"github.run");
});

test("new public Drafts reject retired github.run at every nesting level",async()=>{
 const withData={capability:"github.action",action};
 for(const source of [draft("github.run",withData),
  {version:1,name:"Legacy foreach",steps:[{id:"each",flow:"foreach",items:{ref:"inputs.items"},max_items:2,template:{steps:[{id:"task",uses:"github.run",with:withData}]}}]},
  {version:1,name:"Legacy repeat",steps:[{id:"each",flow:"repeat",times:2,template:{uses:"github.run",with:withData}}]},
 ]) await assert.rejects(compilePublicPlan(source),error=>error instanceof Error&&error.message.includes("github_run_retired"));
});
