import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { IntentLedger } from "../src/intents.ts";

const endpoint_id="11111111-1111-4111-8111-111111111111";
const other_id="22222222-2222-4222-8222-222222222222";
const t=Date.UTC(2026,9,28,13,20,0);
function uuid7(ms=t,tail=0) {
  const timestamp=ms.toString(16).padStart(12,"0");
  return timestamp.slice(0,8)+"-"+timestamp.slice(8)+"-7000-8000-"+tail.toString(16).padStart(12,"0");
}
function fixture(){
  const db=new DatabaseSync(":memory:");
  const sql={exec(statement,...values){
    const prepared=db.prepare(statement);
    if(prepared.columns().length){
      const rows=prepared.all(...values);
      return {toArray(){return rows;},rowsWritten:0};
    }
    const result=prepared.run(...values);
    return {toArray(){return [];},rowsWritten:Number(result.changes)};
  }};
  const ledger=new IntentLedger(sql);
  return {ledger, db, sql};
}
const url="https://example.com/safe?token=PRIVATE_FIXTURE_VALUE";
const command=(intent_key=uuid7())=>({endpoint_id,intent_key,action:"tab_open",url});
test("first admission reserves a durable operation; a lost response can recover the identical ID",async()=>{
  const {ledger,db}=fixture();
  const first=await ledger.admit(command(),t);
  assert.equal(first.state,"admitted");
  assert.match(first.operation_id,/^[0-9a-f-]{36}$/);
  const replay=await ledger.admit(command(),t+2000);
  assert.equal(replay.operation_id,first.operation_id);
  assert.equal(replay.state,"admitted");
  const rows=db.prepare("SELECT * FROM browser_intents").all();
  assert.equal(rows.length,1);
  const serialized=JSON.stringify(rows);
  for(const forbidden of ["PRIVATE_FIXTURE_VALUE","/safe","example.com","token="])assert.equal(serialized.includes(forbidden),false,forbidden);
  assert.equal((await ledger.status(endpoint_id,uuid7())).operation_id,first.operation_id);
});
test("same key with changed URL, action or tab returns conflict, not a second admission",async()=>{
  const {ledger,db}=fixture();
  const key=uuid7();
  await ledger.admit(command(key),t);
  for(const changed of [{...command(key),url:"https://example.com/other"},
    {...command(key),action:"tab_navigate",tab_id:17,document_id:"doc-17"},
    {...command(key),action:"tab_close",tab_id:17,document_id:"doc-17",url:undefined}]){
    const r=await ledger.admit(changed,t+300);
    assert.equal(r.error_code,"intent_conflict");
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM browser_intents").get().n,1);
});
test("intent keys must be UUIDv7 with a bounded first-admission clock window",async()=>{
  const {ledger}=fixture();
  for(const intent_key of ["not-a-key","11111111-1111-4111-8111-111111111111",
    uuid7(t-300001),uuid7(t+30001)]){
    const r=await ledger.admit(command(intent_key),t);
    assert.ok(["invalid_intent_key","expired_intent_key","clock_skew"].includes(r.error_code),intent_key);
  }
  assert.equal((await ledger.admit(command(uuid7(t-300000)),t)).state,"admitted");
});
test("different Endpoints cannot retrieve or inherit another Endpoint's operation",async()=>{
  const {ledger}=fixture();
  const key=uuid7();
  const a=await ledger.admit(command(key),t);
  assert.equal((await ledger.status(other_id,key)).error_code,"not_found");
  const b=await ledger.admit({...command(key),endpoint_id:other_id},t);
  assert.notEqual(a.operation_id,b.operation_id);
  assert.equal((await ledger.status(endpoint_id,key)).operation_id,a.operation_id);
});
test("dispatch is durable before permission token is returned and never repeated",async()=>{
  const {ledger,db}=fixture();
  const key=uuid7();
  await ledger.admit(command(key),t);
  const sent=await ledger.dispatch(endpoint_id,key,7,t+5);
  assert.equal(sent.state,"dispatching");
  assert.match(sent.execute_token,/^[0-9a-f]{64}$/);
  assert.equal(db.prepare("SELECT state, generation, execute_token_hash FROM browser_intents").get().state,"dispatching");
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM browser_intents").all()).includes(sent.execute_token),false);
  assert.equal((await ledger.dispatch(endpoint_id,key,7,t+7)).error_code,"already_dispatched");
  assert.equal((await ledger.status(endpoint_id,key)).state,"dispatching");
});
test("two concurrent intents on one Endpoint cannot both receive execute permission",async()=>{
  const {ledger,db}=fixture();
  const a=uuid7(t,101),b=uuid7(t,102);
  await ledger.admit(command(a),t);
  await ledger.admit(command(b),t);
  const both=await Promise.all([ledger.dispatch(endpoint_id,a,1,t+1),ledger.dispatch(endpoint_id,b,1,t+1)]);
  assert.equal(both.filter(r=>r.state==="dispatching").length,1);
  assert.equal(both.filter(r=>r.error_code==="busy").length,1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM browser_intents WHERE state='dispatching'").get().n,1);
});

test("lost dispatch outcomes become Unknown on recovery; a retry never grants a second execute token",async()=>{
  const {ledger}=fixture();
  const key=uuid7();
  await ledger.admit(command(key),t);
  const first=await ledger.dispatch(endpoint_id,key,4,t+1);
  assert.equal(ledger.recoverUnknown(t+2),1);
  assert.equal((await ledger.status(endpoint_id,key)).state,"unknown");
  assert.equal((await ledger.admit(command(key),t+100)).state,"unknown");
  assert.equal((await ledger.dispatch(endpoint_id,key,5,t+101)).error_code,"already_dispatched");
  assert.equal((await ledger.finalize(endpoint_id,key,"f".repeat(64),4,"completed",null,t+200)).error_code,"receipt_mismatch");
  assert.equal((await ledger.finalize(endpoint_id,key,first.execute_token,5,"completed",null,t+200)).error_code,"receipt_mismatch");
  assert.equal((await ledger.finalize(endpoint_id,key,first.execute_token,4,"completed",39,t+200)).state,"completed");
  assert.equal((await ledger.status(endpoint_id,key)).tab_id,39);
});
test("a reconstructed SQLite ledger preserves its HMAC identity and converts in-flight dispatch to Unknown",async()=>{
  const {ledger,sql}=fixture();
  const key=uuid7(t,99);
  const original=await ledger.admit(command(key),t);
  const sent=await ledger.dispatch(endpoint_id,key,8,t+1);
  // A new owner DO instance shares only SQLite, not the old in-memory Promise.
  const recreated=new IntentLedger(sql);
  assert.equal(recreated.recoverUnknown(t+2),1);
  const duplicate=await recreated.admit(command(key),t+3);
  assert.equal(duplicate.operation_id,original.operation_id);
  assert.equal(duplicate.state,"unknown");
  assert.equal((await recreated.dispatch(endpoint_id,key,9,t+4)).error_code,"already_dispatched");
  assert.equal((await recreated.finalize(endpoint_id,key,sent.execute_token,8,"completed",51,t+5)).state,"completed");
});

test("Unknown markers survive cleanup; expired old keys cannot be re-admitted",async()=>{
  const {ledger,db}=fixture();
  const key1=uuid7(t,1),key2=uuid7(t,2);
  await ledger.admit(command(key1),t);await ledger.admit(command(key2),t);
  const execution=await ledger.dispatch(endpoint_id,key1,1,t+10);
  ledger.recoverUnknown(t+20);
  const second=await ledger.dispatch(endpoint_id,key2,1,t+30);
  await ledger.finalize(endpoint_id,key2,second.execute_token,1,"completed",15,t+35);
  ledger.sweep(t+8*86400000);
  assert.equal((await ledger.status(endpoint_id,key1)).state,"unknown");
  assert.equal((await ledger.status(endpoint_id,key2)).error_code,"not_found");
  assert.equal((await ledger.admit(command(key2),t+8*86400000)).error_code,"expired_intent_key");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM browser_intents").get().n,1);
  assert.ok(execution.execute_token);
});
test("unknown capacity denies additional admissions without deleting evidence",async()=>{
  const {ledger,db}=fixture();
  for(let i=0;i<2;i++){
    const key=uuid7(t,i);
    await ledger.admit(command(key),t);
    await ledger.dispatch(endpoint_id,key,1,t+i);
    ledger.recoverUnknown(t+i+1);
  }
  const answer=await ledger.admit(command(uuid7(t,3)),t+100,{maxUnknown:2});
  assert.equal(answer.error_code,"unknown_capacity_exceeded");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM browser_intents").get().n,2);
});

test("durable prepare binding survives a fresh ledger while never storing raw command",async()=>{
  const {ledger,sql,db}=fixture();
  const key=uuid7();
  const first=await ledger.admit(command(key),t);
  assert.equal(first.fresh,true);
  assert.equal(ledger.bindPrepare(endpoint_id,key,5,2,t+1),true);
  const recovered=new IntentLedger(sql);
  assert.equal(recovered.matchesPrepare(endpoint_id,key,first.operation_id,5,2,t+100),true);
  assert.equal(recovered.matchesPrepare(endpoint_id,key,first.operation_id,6,2,t+100),false);
  assert.equal(recovered.matchesPrepare(endpoint_id,key,first.operation_id,5,3,t+100),false);
  assert.equal(recovered.matchesPrepare(endpoint_id,key,first.operation_id,5,2,t+9000),false);
  const row=db.prepare("SELECT * FROM browser_intents").get();
  assert.equal(JSON.stringify(row).includes("PRIVATE_FIXTURE_VALUE"),false);
});

test("a confirmed browser effect requires a stable numeric tab ID; malformed completion stays unconfirmed",async()=>{
  const {ledger,db}=fixture();
  const key=uuid7(t,707);
  await ledger.admit(command(key),t);
  const dispatch=await ledger.dispatch(endpoint_id,key,7,t+1);
  assert.equal(dispatch.state,"dispatching");
  const invalid=await ledger.finalize(endpoint_id,key,dispatch.execute_token,7,"completed",null,t+2);
  assert.equal(invalid.error_code,"invalid_arguments");
  assert.equal((await ledger.status(endpoint_id,key)).state,"dispatching");
  ledger.recoverUnknown(t+3);
  assert.equal((await ledger.status(endpoint_id,key)).state,"unknown");
  const late=await ledger.finalize(endpoint_id,key,dispatch.execute_token,7,"completed",12,t+4);
  assert.equal(late.state,"completed");
  assert.equal(late.tab_id,12);
  db.close();
});

test("nonfatal tab grouping failure survives original-key operation status without disclosing URL",async()=>{
  const {ledger,db}=fixture();
  const key=uuid7(t,999);
  await ledger.admit(command(key),t);
  const dispatched=await ledger.dispatch(endpoint_id,key,4,t+1);
  const outcome=await ledger.finalize(endpoint_id,key,dispatched.execute_token,4,"completed",73,
    t+2,"tab_group_unavailable");
  assert.equal(outcome.state,"completed");
  assert.equal(outcome.tab_id,73);
  assert.equal(outcome.presentation_warning,"tab_group_unavailable");
  const recovered=ledger.status(endpoint_id,key);
  assert.equal(recovered.presentation_warning,"tab_group_unavailable");
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM browser_intents").all()).includes("PRIVATE_FIXTURE_VALUE"),false);
});

test("owner-reported Unknown resolution stays distinct from observed success and cannot be replayed",async()=>{
  const {ledger,db}=fixture();
  const key=uuid7(t,1001);
  await ledger.admit(command(key),t);
  const dispatched=await ledger.dispatch(endpoint_id,key,5,t+1);
  ledger.recoverUnknown(t+2);
  const reported=ledger.ownerReport(endpoint_id,key,"effect_seen",t+3);
  assert.equal(reported.state,"owner_reported_resolution");
  assert.equal(reported.owner_reported_resolution,"effect_seen");
  assert.notEqual(reported.state,"completed");
  assert.equal(ledger.activitySummary(endpoint_id).unknown,0);
  assert.equal((await ledger.admit(command(key),t+4)).state,"owner_reported_resolution");
  assert.equal((await ledger.dispatch(endpoint_id,key,6,t+5)).error_code,"already_dispatched");
  ledger.sweep(t+8*86400000);
  assert.equal(ledger.status(endpoint_id,key).state,"owner_reported_resolution");
  // A late cryptographically matching original receipt can still add an observed fact.
  assert.equal((await ledger.finalize(endpoint_id,key,dispatched.execute_token,5,"completed",39,t+9)).state,"completed");
  assert.equal(ledger.status(endpoint_id,key).owner_reported_resolution,"effect_seen");
  db.close();
});
