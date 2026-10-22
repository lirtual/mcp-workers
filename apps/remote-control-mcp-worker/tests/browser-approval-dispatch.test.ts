import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import test from "node:test";
import {V2OwnerCoordinator} from "../src/worker.ts";
import {approveBrowserIntent,inspectBrowserIntent} from "../src/browser-approval.ts";
import {browserApprovalPage} from "../src/browser-approval-web.ts";

function context(){
  const id=randomUUID(),sid=randomUUID(),epoch=randomUUID();
  const commands:Array<{kind:string;tool:string;operation_id?:string}>= [];
  const data=new Map<string,unknown>([
    ["device:"+id,{device_id:id,revoked:false}],
    ["session:epoch:"+id,epoch],
  ]);
  let currentPage="https://example.com/review";
  let currentTab="tab-1";
  let lock=Promise.resolve();
  const tx={
    get:async<T>(k:string)=>data.get(k) as T|undefined,
    put:async(k:string,v:unknown)=>{data.set(k,v);},
    delete:async(k:string)=>{data.delete(k);},
    list:async<T>(o:{prefix:string;limit:number})=>
      new Map([...data].filter(([k])=>k.startsWith(o.prefix)).slice(0,o.limit)) as Map<string,T>,
  };
  const storage={...tx,transaction:async<T>(f:(t:typeof tx)=>Promise<T>)=>{
    let release!:()=>void;
    const next=new Promise<void>(resolve=>{release=resolve;});
    const prev=lock;lock=next;await prev;
    try{return await f(tx);}finally{release();}
  }};
  let coordinator!:V2OwnerCoordinator;
  const sock={readyState:WebSocket.OPEN,
    deserializeAttachment:()=>({device_id:id,epoch}),
    send(frame:string){
      const req=JSON.parse(frame) as {kind:string;tool:string;request_id:string;operation_id?:string};
      commands.push({kind:req.kind,tool:req.tool,operation_id:req.operation_id});
      const result=req.kind==="read"?
        {kind:"read_result",request_id:req.request_id,status:"completed",
          text:JSON.stringify({session_id:sid,selected_tab_id:currentTab,
            tabs:[{tab_id:currentTab,url:currentPage,title:"Test page"}]})}:
        {kind:"operation_result",request_id:req.request_id,
          result:{operation_id:req.operation_id,status:"completed"}};
      queueMicrotask(()=>{void coordinator.webSocketMessage(sock as WebSocket,JSON.stringify(result));});
    },
    close(){},
  } as unknown as WebSocket;
  coordinator=new V2OwnerCoordinator({storage,
    getWebSockets:(tag:string)=>tag==="device:"+id?[sock]:[],
  } as unknown as DurableObjectState);
  const operation_id="spec152-sensitive-"+randomUUID();
  const args={
    session_id:sid,role:"button",name:"Confirm transfer",snapshot_version:3,
  };
  async function dispatch(changes:Record<string,unknown>={}){
    const envelope={device_id:id,tool:"browser_click",operation_id,arguments:args,...changes};
    const resp=await coordinator.fetch(new Request("https://v2.internal/browser-approval/dispatch",{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify(envelope),
    }));
    return{status:resp.status,data:await resp.json() as Record<string,unknown>};
  }
  return{id,sid,epoch,commands,dispatch,data,storage,operation_id,args,
    setPage:(url:string)=>{currentPage=url;},
    setTab:(tab:string)=>{currentTab=tab;},
  };
}

test("exact Agent-selected origin and tab require verified owner approval before any click",async()=>{
  const test=context();
  const prepared=await test.dispatch();
  assert.equal(prepared.status,200);
  assert.equal(prepared.data.status,"confirmation_required");
  assert.match(String(prepared.data.approval_id),/^[a-f0-9-]{36}$/);
  assert.deepEqual(test.commands.map(c=>c.kind),["read"]);
  const same=await test.dispatch();
  assert.equal(same.data.approval_id,prepared.data.approval_id);
  assert.equal(test.commands.filter(c=>c.kind==="operation").length,0);
  const invalid=await test.dispatch({arguments:{...test.args,name:"Submit another transaction"}});
  assert.equal(invalid.data.status,"conflict");
  assert.equal(test.commands.filter(c=>c.kind==="operation").length,0);
});

test("approved once then dispatched once; replay, changed page, revoked epoch fail closed",async()=>{
  const test=context();
  // Retrieve the existing simulated DO durable SQLite storage through its
  // private fixture state to authorize only after inspecting the pending ID.
  const prepared=await test.dispatch();
  const id=String(prepared.data.approval_id);
  assert.equal(await approveBrowserIntent(test.storage as unknown as Pick<DurableObjectStorage,"transaction">,
    id,"owner-subject"),"approved");
  const sent=await test.dispatch();
  assert.equal(sent.data.status,"completed");
  assert.equal(test.commands.filter(c=>c.kind==="operation").length,1);
  const repeated=await test.dispatch();
  assert.equal(repeated.data.status,"unavailable");
  assert.equal(test.commands.filter(c=>c.kind==="operation").length,1);

  const changed=context();
  const a=await changed.dispatch();
  assert.equal(await approveBrowserIntent(changed.storage as unknown as Pick<DurableObjectStorage,"transaction">,
    String(a.data.approval_id),"owner"),"approved");
  changed.setPage("https://other.example/new");
  const stale=await changed.dispatch();
  assert.equal(stale.data.status,"conflict");
  assert.equal(changed.commands.filter(c=>c.kind==="operation").length,0);

  changed.setPage("https://example.com/review");
  changed.data.delete("session:epoch:"+changed.id);
  const revoked=await changed.dispatch();
  assert.equal(revoked.status,503);
  assert.equal(changed.commands.filter(c=>c.kind==="operation").length,0);
});

test("same-origin path or query changes cannot reuse consent; URL query stays out of storage",async()=>{
  for(const [start,next] of [
    ["https://example.com/review","https://example.com/submit"],
    ["https://example.com/review?private_token=do-not-persist",
     "https://example.com/review?private_token=changed"],
  ] as const){
    const t=context();
    t.setPage(start);
    const first=await t.dispatch();
    assert.equal(first.data.status,"confirmation_required");
    const record=await inspectBrowserIntent(
      t.storage as unknown as Pick<DurableObjectStorage,"transaction">,
      String(first.data.approval_id));
    assert.ok(record);
    assert.equal(record.intent.origin,"https://example.com");
    assert.ok(record.intent.page_path.startsWith("/"));
    const serialized=JSON.stringify([...t.data.entries()]);
    assert.equal(serialized.includes("do-not-persist"),false);
    assert.equal(serialized.includes("private_token="),false);
    assert.equal(await approveBrowserIntent(
      t.storage as unknown as Pick<DurableObjectStorage,"transaction">,
      String(first.data.approval_id),"owner"),"approved");
    t.setPage(next);
    const changed=await t.dispatch();
    assert.equal(changed.data.status,"conflict");
    assert.equal(t.commands.filter(c=>c.kind==="operation").length,0);
  }
});

test("fill requires exact one-use owner approval and never stores or displays entered text",async()=>{
  const t=context();
  const entered="example-private-form-value-never-persist";
  const fillArgs={
    session_id:t.sid,role:"textbox",name:"Account reference",
    snapshot_version:3,text:entered,
  };
  const first=await t.dispatch({tool:"browser_fill",arguments:fillArgs});
  assert.equal(first.status,200);
  assert.equal(first.data.status,"confirmation_required");
  assert.equal(t.commands.filter(x=>x.kind==="operation").length,0);
  const approvalId=String(first.data.approval_id);
  const record=await inspectBrowserIntent(
    t.storage as unknown as Pick<DurableObjectStorage,"transaction">,approvalId);
  assert.ok(record);
  assert.equal(record.intent.tool,"browser_fill");
  assert.match(record.intent.display,/Account reference/);
  assert.match(record.intent.display,/contents hidden/);
  assert.equal(JSON.stringify([...t.data.entries()]).includes(entered),false);
  assert.equal(JSON.stringify(first.data).includes(entered),false);
  const page=await browserApprovalPage(approvalId,record).text();
  assert.match(page,/Fill textbox Account reference/);
  assert.equal(page.includes(entered),false);
  assert.equal(page.includes("contents hidden"),true);
  const changed=await t.dispatch({tool:"browser_fill",
    arguments:{...fillArgs,text:"different-value"}});
  assert.equal(changed.data.status,"conflict");
  assert.equal(t.commands.filter(x=>x.kind==="operation").length,0);
  assert.equal(await approveBrowserIntent(
    t.storage as unknown as Pick<DurableObjectStorage,"transaction">,
    approvalId,"owner-access-subject"),"approved");
  const sent=await t.dispatch({tool:"browser_fill",arguments:fillArgs});
  assert.equal(sent.data.status,"completed");
  assert.equal(t.commands.filter(x=>x.kind==="operation").length,1);
  const repeated=await t.dispatch({tool:"browser_fill",arguments:fillArgs});
  assert.equal(repeated.data.status,"unavailable");
  assert.equal(t.commands.filter(x=>x.kind==="operation").length,1);
});
