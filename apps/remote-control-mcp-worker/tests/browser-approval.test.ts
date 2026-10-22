import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {test} from "node:test";
import {prepareBrowserIntent,approveBrowserIntent,consumeBrowserApproval,
  validBrowserIntent,type BrowserApprovalIntent} from "../src/browser-approval.ts";

type FakeTx = {
  get<T>(key:string):Promise<T|undefined>;
  put(key:string,value:unknown):Promise<void>;
  delete(key:string):Promise<void>;
  list<T>(options:{prefix:string;limit:number}):Promise<Map<string,T>>;
};
function storage() {
  const records=new Map<string,unknown>();
  let gate=Promise.resolve();
  const tx:FakeTx={
    get:async <T>(key:string)=>records.get(key) as T|undefined,
    put:async (key:string,value:unknown)=>{records.set(key,value);},
    delete:async (key:string)=>{records.delete(key);},
    list:async <T>(o:{prefix:string;limit:number})=>
      new Map([...records].filter(([key])=>key.startsWith(o.prefix)).slice(0,o.limit)) as Map<string,T>,
  };
  return {records,transaction:async <T>(fn:(current:FakeTx)=>Promise<T>):Promise<T>=>{
    let release!:()=>void;
    const next=new Promise<void>(resolve=>{release=resolve;});
    const prev=gate;gate=next;
    await prev;
    try{return await fn(tx);}finally{release();}
  }} as unknown as Pick<DurableObjectStorage,"transaction">;
}
const descriptor=():BrowserApprovalIntent=>({
  device_id:randomUUID(),epoch:randomUUID(),session_id:randomUUID(),
  tab_id:"tab-1",operation_id:"spec152-"+randomUUID(),
  tool:"browser_click",snapshot_version:3,origin:"https://example.com",
  page_path:"/review",page_digest:"c".repeat(64),parameters_digest:"a".repeat(64),display:"Click confirm button on example.com",
});

test("pending intent is stable, bound to exact arguments, and not model-approved",async()=>{
  const s=storage(),intent=descriptor(),now=1_800_000;
  assert.equal(validBrowserIntent(intent),true);
  const first=await prepareBrowserIntent(s,intent,now);
  assert.equal(first.status,"pending");
  if(first.status!=="pending")throw Error("unreachable");
  assert.deepEqual(await prepareBrowserIntent(s,intent,now+5),first);
  assert.equal(await consumeBrowserApproval(s,intent,now+5),false);
  assert.equal(await approveBrowserIntent(s,first.approval_id,"",now+5),"denied");
  assert.equal(await approveBrowserIntent(s,first.approval_id,"chatgpt-model",now+TTL+1),"denied");
  assert.equal((await prepareBrowserIntent(s,{...intent,parameters_digest:"b".repeat(64)},now+5)).status,"conflict");
  assert.equal((await prepareBrowserIntent(s,{...intent,tab_id:"tab-2"},now+5)).status,"conflict");
  assert.equal((await prepareBrowserIntent(s,{...intent,page_digest:"d".repeat(64)},now+5)).status,"conflict");
  assert.equal((await prepareBrowserIntent(s,{...intent,page_path:"/other"},now+5)).status,"conflict");
  assert.equal((await prepareBrowserIntent(s,{...intent,epoch:randomUUID()},now+5)).status,"conflict");
  assert.equal((await prepareBrowserIntent(s,intent,now+TTL+1)).status,"expired");
});
const TTL=10 * 60_000;

test("independently verified owner approval consumes exactly once; replay and changed target denied",async()=>{
  const s=storage(),intent=descriptor(),now=1_800_000;
  const pending=await prepareBrowserIntent(s,intent,now);
  assert.equal(pending.status,"pending");
  if(pending.status!=="pending")throw Error("unreachable");
  assert.equal(await approveBrowserIntent(s,pending.approval_id,"owner@example.com",now+500),"approved");
  assert.equal(await approveBrowserIntent(s,pending.approval_id,"owner@example.com",now+600),"denied");
  assert.equal(await consumeBrowserApproval(s,{...intent,session_id:randomUUID()},now+750),false);
  assert.equal(await consumeBrowserApproval(s,{...intent,snapshot_version:4},now+750),false);
  assert.equal(await consumeBrowserApproval(s,{...intent,origin:"https://evil.example"},now+750),false);
  const outcomes=await Promise.all(Array.from({length:12},()=>consumeBrowserApproval(s,intent,now+800)));
  assert.equal(outcomes.filter(Boolean).length,1);
  assert.equal(await consumeBrowserApproval(s,intent,now+900),false);
  assert.equal((await prepareBrowserIntent(s,intent,now+900)).status,"consumed");
});

test("short-lived independent consent rejects expired and unknown challenges",async()=>{
  const s=storage(),intent=descriptor();
  const pending=await prepareBrowserIntent(s,intent,1000);
  if(pending.status!=="pending")throw Error("unreachable");
  assert.equal(await approveBrowserIntent(s,randomUUID(),"owner@example.com",1050),"denied");
  assert.equal(await approveBrowserIntent(s,pending.approval_id,"owner@example.com",601_000),"denied");
  assert.equal(await consumeBrowserApproval(s,intent,601_000),false);
});

test("malformed or missing Agent-observed context always fails closed",async()=>{
  const s=storage(),intent=descriptor();
  for(const mutation of [
    {epoch:""}, {origin:"file:///etc/passwd"}, {origin:"https://example.com/path"},
    {tool:"browser_start"}, {snapshot_version:-1},
    {page_digest:"invalid"}, {page_path:"/review?token=x"}, {parameters_digest:"wrong"},
    {display:"<script>\n"}, {session_id:"wrong"},
  ])assert.equal((await prepareBrowserIntent(s,{...intent,...mutation})).status,"invalid");
});

test("bounded pending capacity recovers by lazy expiration without alarms",async()=>{
  const s=storage(),start=1000;
  for(let i=0;i<32;i++){
    const result=await prepareBrowserIntent(s,descriptor(),start);
    assert.equal(result.status,"pending");
  }
  assert.equal((await prepareBrowserIntent(s,descriptor(),start)).status,"capacity");
  // Ten-minute consent window plus short tombstone age has elapsed.
  assert.equal((await prepareBrowserIntent(s,descriptor(),start+10*60_000+5*60_000+1)).status,"pending");
});
