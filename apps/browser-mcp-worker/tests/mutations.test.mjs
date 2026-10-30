import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../extension");
const observation=fs.readFileSync(path.join(root,"observation.js"),"utf8");
const mutations=fs.readFileSync(path.join(root,"mutations.js"),"utf8");
const endpoint_id="11111111-1111-4111-8111-111111111111";
const intent_key="019a2b3c-4d5e-7aaa-8bbb-1234567890ab";
function setup(){
  const calls=[];
  const tab={id:42,windowId:1,active:false,incognito:false,url:"https://example.com/original"};
  const chrome={
    tabs:{
      query:async()=>[tab],
      get:async id=>{calls.push(["get",id]);return tab;},
      create:async details=>{calls.push(["create",details]);return {id:73,windowId:1,...details};},
      update:async(id,details)=>{calls.push(["update",id,details]);return {id};},
      remove:async id=>{calls.push(["remove",id]);},
      group:async details=>{calls.push(["group",details]);throw Error("group unavailable");}
    },
    webNavigation:{getFrame:async()=>({documentId:"doc-42",documentLifecycle:"active",url:tab.url})},
    tabGroups:{query:async options=>{calls.push(["query-groups",options]);return [];},update:async()=>{throw Error("group unavailable");}}
  };
  const ctx=vm.createContext({chrome,URL,Number,decodeURIComponent,console,BROWSER_MCP_SERVICE_ORIGIN:"https://browser-mcp-worker.invalid"});
  vm.runInContext(observation,ctx);
  vm.runInContext(mutations,ctx);
  const execute=(command,authorized)=>vm.runInContext("browserExecuteMutation(command,authorized)",Object.assign(ctx,{command,authorized}));
  return {chrome,calls,tab,execute};
}
const cmd=(action,extra={})=>({endpoint_id,intent_key,action,...extra});
test("source-only tab creation yields one confirmed tab and nonfatal presentation warning",async()=>{
  const {execute,calls}=setup();
  const result=await execute(cmd("tab_open",{url:"https://example.com/clean"}));
  assert.equal(result.state,"completed");
  assert.equal(result.tab_id,73);
  assert.equal(result.presentation_warning,"tab_group_unavailable");
  assert.equal(calls.filter(x=>x[0]==="create").length,1);
});
test("owner Stop recheck blocks all tab effects after async prevalidation",async()=>{
  const {execute,calls}=setup();
  const result=await execute(cmd("tab_navigate",{url:"https://example.com/new",tab_id:42,document_id:"doc-42"}),async()=>false);
  assert.equal(result.state,"failed");
  assert.equal(result.error_code,"stopped");
  assert.equal(calls.filter(x=>["create","update","remove"].includes(x[0])).length,0);
});
test("stale document identity and sensitive URLs never call tab mutation APIs",async()=>{
  const {execute,calls}=setup();
  const stale=await execute(cmd("tab_close",{tab_id:42,document_id:"wrong-document"}));
  assert.equal(stale.error_code,"stale_target");
  for(const url of ["file:///etc/passwd","https://accounts.google.com/",
    "http://127.0.0.1/private","https://example.com/logout","https://example.com/delete"]){
    const r=await execute(cmd("tab_open",{url}));
    assert.equal(r.error_code,"forbidden",url);
  }
  assert.equal(calls.filter(x=>["create","update","remove"].includes(x[0])).length,0);
});
test("explicit matching tab and document route only the intended navigate and close",async()=>{
  const {execute,calls}=setup();
  const navigate=await execute(cmd("tab_navigate",{tab_id:42,document_id:"doc-42",url:"https://example.com/new"}));
  const closed=await execute(cmd("tab_close",{tab_id:42,document_id:"doc-42"}));
  assert.deepEqual([navigate.state,closed.state],["completed","completed"]);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.filter(x=>["update","remove"].includes(x[0])))),[
    ["update",42,{url:"https://example.com/new"}],["remove",42]
  ]);
});


test("new tabs reuse the same named group only within their window; manual rename creates a new group",async()=>{
  const {execute,calls,chrome,tab}=setup();
  const groups=[];let nextId=80,nextGroup=200,windowId=1;
  chrome.tabs.create=async details=>{const created={id:nextId++,windowId,...details};calls.push(["create",details]);return created;};
  chrome.tabGroups.query=async args=>{
    calls.push(["query-groups",args]);
    return groups.filter(g=>g.windowId===args.windowId&&g.title===args.title);
  };
  chrome.tabs.group=async options=>{
    calls.push(["group",options]);
    if(options.groupId!==undefined)return options.groupId;
    const id=nextGroup++;groups.push({id,windowId:options.createProperties?.windowId??windowId,title:"",shared:false});
    return id;
  };
  chrome.tabGroups.update=async(groupId,values)=>{
    calls.push(["name-group",groupId,values]);
    Object.assign(groups.find(g=>g.id===groupId),values);
  };
  const first=await execute(cmd("tab_open",{url:"https://example.com/a"}));
  const second=await execute(cmd("tab_open",{url:"https://example.com/b"}));
  assert.equal(first.state,"completed");
  assert.equal(second.state,"completed");
  assert.equal(groups.length,1,"one reusable neutral group for two tabs");
  assert.equal(groups[0].title,"Browser MCP");
  const beforeRename=calls.filter(x=>x[0]==="group");
  assert.equal(beforeRename.length,2);
  assert.ok(Object.hasOwn(beforeRename[0][1],"createProperties"));
  assert.equal(beforeRename[1][1].groupId,200);
  // User manually renames the existing group: do not rename it back or move tabs.
  groups[0].title="My own tabs";
  await execute(cmd("tab_open",{url:"https://example.com/c"}));
  assert.equal(groups[0].title,"My own tabs");
  assert.equal(groups.length,2);
  assert.equal(groups[1].title,"Browser MCP");
  // A tab in another window must not be moved into the first window's group.
  windowId=2;tab.windowId=2;
  await execute(cmd("tab_open",{url:"https://example.com/d"}));
  assert.equal(groups.length,3);
  assert.equal(groups[2].windowId,2);
  assert.equal(calls.filter(x=>x[0]==="name-group").length,3);
});

test("shared groups with the same neutral title are not adopted automatically",async()=>{
  const {execute,calls,chrome}=setup();
  chrome.tabGroups.query=async()=>[{id:88,windowId:1,title:"Browser MCP",shared:true}];
  chrome.tabs.group=async args=>{calls.push(["group",args]);return 96;};
  chrome.tabGroups.update=async(id,settings)=>{calls.push(["name-group",id,settings]);};
  const r=await execute(cmd("tab_open",{url:"https://example.com/public"}));
  assert.equal(r.state,"completed");
  const options=calls.find(x=>x[0]==="group")[1];
  assert.equal(options.groupId,undefined);
  assert.equal(options.createProperties.windowId,1);
  assert.equal(calls.filter(x=>x[0]==="name-group").length,1);
});

test("consequential GET query and encoded routes are denied without a remote approval bypass",async()=>{
  const {execute,calls}=setup();
  for(const url of [
    "https://example.com/operations?confirm=1",
    "https://example.com/item?delete=true",
    "https://example.com/api?transfer=100",
    "https://example.com/%70ayment",
    "https://example.com/%ZZ/confirm"
  ]){
    const r=await execute(cmd("tab_open",{url}));
    assert.equal(r.error_code,"forbidden",url);
  }
  assert.equal(calls.filter(x=>x[0]==="create").length,0);
});
