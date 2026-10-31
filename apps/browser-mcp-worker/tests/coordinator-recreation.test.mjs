import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {BrowserOwner} from "../src/coordinator.ts";
import {IntentLedger} from "../src/intents.ts";

const id="11111111-1111-4111-8111-111111111111";
function uuid7(ms=Date.now()){
  const stamp=ms.toString(16).padStart(12,"0");
  return stamp.slice(0,8)+"-"+stamp.slice(8)+"-7000-8000-000000000001";
}
function fixture(){
  const db=new DatabaseSync(":memory:");
  const sql={exec(statement,...values){
    const stmt=db.prepare(statement);
    if(stmt.columns().length){
      const rows=stmt.all(...values);
      return {toArray:()=>rows,rowsWritten:0};
    }
    const result=stmt.run(...values);
    return {toArray:()=>[],rowsWritten:Number(result.changes)};
  }};
  const sent=[];
  const socket={
    readyState:1,
    deserializeAttachment(){return {
      authenticated:true,protocol:3,extension_version:"0.2.5",endpoint_id:id,generation:7,deadline:0,last_seen:Date.now()
    };},
    send(message){sent.push(JSON.parse(message));},
    close(){sent.push({type:"closed"});}
  };
  const state={storage:{sql},getWebSockets:()=>[socket]};
  const first=new BrowserOwner(state);
  sql.exec("INSERT INTO endpoints(id,alias,credential_hash,state,generation,revision,updated_at) VALUES(?,?,?,'enabled',7,2,?)",
    id,"test-profile","a".repeat(64),Date.now());
  return {db,sql,first,state,socket,sent,ledger:new IntentLedger(sql)};
}

test("DO re-creation drops memory-only prepare: unsolicited late prepare_result cannot dispatch",async()=>{
  const f=fixture(),intent_key=uuid7();
  const command={endpoint_id:id,intent_key,action:"tab_open",url:"https://example.com/test-only"};
  const accepted=await f.ledger.admit(command);
  assert.equal(accepted.state,"admitted");
  assert.equal(f.ledger.bindPrepare(id,intent_key,7,2),true);
  // The new object shares the old durable SQLite and original socket attachment,
  // but has no in-memory pending mutation or its timer.
  const restored=new BrowserOwner(f.state);
  await restored.webSocketMessage(f.socket,JSON.stringify({
    type:"prepare_result",operation_id:accepted.operation_id,
    intent_key,generation:7,accepted:true
  }));
  assert.deepEqual(f.sent,[],"a late frame without pending context must never emit execute");
  assert.equal(f.ledger.status(id,intent_key).state,"admitted",
    "lost prepare must never advance to durable dispatching");
  f.ledger.reconcile(Date.now()+9000);
  assert.equal(f.ledger.status(id,intent_key).state,"failed");
  assert.equal(f.db.prepare("SELECT execute_token_hash FROM browser_intents").get().execute_token_hash,null);
  f.db.close();
});

test("DO re-creation of already dispatched intent remains Unknown, never reissues token",async()=>{
  const f=fixture(),intent_key=uuid7();
  const command={endpoint_id:id,intent_key,action:"tab_open",url:"https://example.com/test-only"};
  const admitted=await f.ledger.admit(command);
  assert.equal(f.ledger.bindPrepare(id,intent_key,7,2),true);
  const dispatched=await f.ledger.dispatch(id,intent_key,7);
  assert.equal(dispatched.state,"dispatching");
  assert.ok(dispatched.execute_token);
  const restored=new BrowserOwner(f.state);
  assert.equal(f.ledger.status(id,intent_key).state,"unknown");
  await restored.webSocketMessage(f.socket,JSON.stringify({
    type:"prepare_result",operation_id:admitted.operation_id,
    intent_key,generation:7,accepted:true
  }));
  assert.deepEqual(f.sent,[]);
  assert.equal(f.ledger.status(id,intent_key).state,"unknown");
  assert.equal((await f.ledger.admit(command)).operation_id,admitted.operation_id);
  f.db.close();
});


test("async intent admission reserves the Endpoint before HMAC, blocking both overlapping reads and writes",async()=>{
  const f=fixture(),owner=f.first;
  let entered,release;
  const admissionEntered=new Promise(resolve=>{entered=resolve;});
  const admissionGate=new Promise(resolve=>{release=resolve;});
  const original=owner.intents.admit.bind(owner.intents);
  owner.intents.admit=async(...args)=>{
    entered();
    await admissionGate;
    return original(...args);
  };
  const request=(route,body)=>new Request("https://owner.internal/"+route,{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)
  });
  const firstKey=uuid7();
  const first=owner.fetch(request("mutate",{
    endpoint_id:id,intent_key:firstKey,action:"tab_open",url:"https://example.com/one"
  }));
  await admissionEntered;
  try{
    const read=await owner.fetch(request("read",{endpoint_id:id,tool:"tabs"}));
    assert.equal(read.status,409);
    assert.equal((await read.json()).error_code,"busy");
    const second=await owner.fetch(request("mutate",{
      endpoint_id:id,intent_key:uuid7(Date.now()+1),action:"tab_open",url:"https://example.com/two"
    }));
    assert.equal(second.status,409);
    assert.equal((await second.json()).error_code,"busy");
    assert.equal(f.sent.length,0,"a second operation must not be sent during admission");
  }finally{release();}
  const admitted=await first;
  assert.equal(admitted.status,200);
  assert.equal((await admitted.json()).state,"admitted");
  assert.equal(f.sent.filter(s=>s.type==="prepare_request").length,1);
  owner.close(id,"stopped"); // clear the test-only timer, never exercise a real browser
  f.db.close();
});

test("snapshot socket close retains only a bounded in-flight stage and close code",async()=>{
  const f=fixture();
  try {
    const read=f.first.fetch(new Request("https://owner.internal/read",{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({endpoint_id:id,tool:"snapshot",tab_id:41})
    }));
    for(let i=0;i<30&&!f.sent.some(x=>x.type==="read_request");i++)
      await new Promise(resolve=>setImmediate(resolve));
    const request=f.sent.find(x=>x.type==="read_request");
    assert.ok(request,"snapshot must reach current socket");
    // Invalid and cross-request progress must not enter the diagnostic receipt.
    await f.first.webSocketMessage(f.socket,JSON.stringify({
      type:"read_progress",request_id:request.request_id,
      generation:7,stage:"https://example.com/?secret=DO_NOT_ECHO"
    }));
    await f.first.webSocketMessage(f.socket,JSON.stringify({
      type:"read_progress",request_id:request.request_id,
      generation:7,stage:"text_injection"
    }));
    await f.first.webSocketClose(f.socket,1006,"contains_PRIVATE_REASON",false);
    const outcome=await (await read).json();
    assert.equal(outcome.error_code,"offline");
    assert.equal(outcome.stage,"text_injection");
    assert.equal(outcome.close_code,1006);
    assert.ok(Number.isInteger(outcome.stage_elapsed_ms));
    assert.ok(outcome.stage_elapsed_ms>=0&&outcome.stage_elapsed_ms<=5000);
    assert.deepEqual(Object.keys(outcome).sort(),["close_code","error_code","stage","stage_elapsed_ms"]);
    assert.doesNotMatch(JSON.stringify(outcome),/DO_NOT_ECHO|PRIVATE_REASON|example.com/);
  }finally{f.db.close();}
});


test("old live socket without the new extension version cannot accept reads or writes",async()=>{
  const f=fixture();
  try {
    const oldSocket={...f.socket,deserializeAttachment:()=>({
      authenticated:true,protocol:3,endpoint_id:id,generation:7,deadline:0,last_seen:Date.now()
    })};
    const owner=new BrowserOwner({storage:f.state.storage,getWebSockets:()=>[oldSocket]});
    const post=async(path,body)=>await owner.fetch(new Request('https://owner.internal/'+path,{
      method:'POST',body:JSON.stringify(body)}));
    const read=await post('read',{endpoint_id:id,tool:'tabs'});
    assert.equal((await read.json()).error_code,'offline');
    const mutation=await post('mutate',{endpoint_id:id,intent_key:uuid7(),action:'tab_open',url:'https://example.com'});
    assert.equal((await mutation.json()).error_code,'offline');
    assert.equal(f.sent.length,0);
    await owner.webSocketMessage(oldSocket,JSON.stringify({type:'ping'}));
    assert.deepEqual(f.sent,[{type:'closed'}]);
  }finally{f.db.close();}
});
