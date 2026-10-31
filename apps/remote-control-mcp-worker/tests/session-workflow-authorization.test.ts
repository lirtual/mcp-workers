import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionAllowedByWorkflow } from '../src/session-workflow-authorization.ts';
import { listApprovedDevices, type V2Device } from '../src/v2-session.ts';
import { V2OwnerCoordinator } from '../src/v2-pairing.ts';

const now = Date.now();
const device: V2Device = {
  device_id:'123e4567-e89b-42d3-a456-426614174001', name:'session-ubuntu',
  public_key:'a'.repeat(60), fingerprint:'ab'.repeat(12), approved_at:now-30_000,
  revoked:false, grant_type:'session', expires_at:now+60_000,
  session_attempt_id:'123e4567-e89b-42d3-a456-426614174002',
  session_run_id:123, session_run_attempt:1, session_workflow_name:'ubuntu',
};
const decision = {
  allowed:true, attempt_id:device.session_attempt_id,
  github_run_id:device.session_run_id, github_run_attempt:device.session_run_attempt,
  workflow_name:device.session_workflow_name, expires_at:device.expires_at,
};

test('private Workflow RPC is required and admits only exact current physical Attempt',async()=>{
  assert.equal(await sessionAllowedByWorkflow()(device),false);
  let calls=0;
  const check=sessionAllowedByWorkflow({ authorizeSessionAttempt:async input=>{
    calls++;
    assert.deepEqual(input,{attempt_id:device.session_attempt_id});
    return decision;
  }});
  assert.equal(await check(device),true);
  assert.equal(await check(device),true);
  assert.equal(calls,2,'fresh authoritative decision is required for each admission');
});

test('deadline, physical run, attempt, workflow and authorization mismatch deny',async()=>{
  for (const broken of [
    {allowed:false}, {attempt_id:'123e4567-e89b-42d3-a456-426614174999'},
    {github_run_id:124}, {github_run_attempt:2}, {workflow_name:'windows'},
    {expires_at:device.expires_at!+60000}, {expires_at:device.expires_at!-1},
  ]) {
    const check=sessionAllowedByWorkflow({authorizeSessionAttempt:async()=>({...decision,...broken})});
    assert.equal(await check(device),false,JSON.stringify(broken));
  }
});

test('RPC timeout, malformed result and missing attempt fail closed',async()=>{
  for(const reply of [undefined,null,[],{},'allowed']) {
    assert.equal(await sessionAllowedByWorkflow({authorizeSessionAttempt:async()=>reply})(device),false);
  }
  assert.equal(await sessionAllowedByWorkflow({authorizeSessionAttempt:async()=>{throw Error('unavailable')}})(device),false);
  assert.equal(await sessionAllowedByWorkflow({authorizeSessionAttempt:async()=>decision})({...device,session_attempt_id:undefined}),false);
});

test('unavailable Workflow never hides an approved permanent personal device',async()=>{
  const personal:V2Device={...device,device_id:'123e4567-e89b-42d3-a456-426614174003',name:'personal',grant_type:'permanent'};
  const values=new Map<string,V2Device>([
    ['device:'+device.device_id,device],['device:'+personal.device_id,personal],
  ]);
  const state={ storage:{list:async()=>values,delete:async()=>true,get:async()=>undefined},
    getWebSockets:()=>[] } as any;
  const denied=sessionAllowedByWorkflow({authorizeSessionAttempt:async()=>{throw Error('workflow down')}});
  const list=await listApprovedDevices(state,denied);
  assert.equal(list.status,200);
  assert.deepEqual((list.body as Array<{device_id:string}>).map(x=>x.device_id),[personal.device_id]);
});

test('actual owner DO checks live Workflow before new read/mutation and device discovery',async()=>{
  const epoch='owned-session-epoch';
  const personal:V2Device={...device,device_id:'123e4567-e89b-42d3-a456-426614174003',name:'personal',grant_type:'permanent'};
  const rows=new Map<string,unknown>([
    ['device:'+device.device_id,device],['session:epoch:'+device.device_id,epoch],
    ['device:'+personal.device_id,personal],
  ]);
  let admitted=true, admissions=0;
  const sent:Array<Record<string,unknown>>=[];
  let owner!:V2OwnerCoordinator;
  const socket={
    readyState:WebSocket.OPEN,
    deserializeAttachment:()=>({device_id:device.device_id,epoch,last_auth_check_at:Date.now()}),
    send(frame:string){
      const parsed=JSON.parse(frame) as Record<string,unknown>;
      sent.push(parsed);
      queueMicrotask(()=>{void owner.webSocketMessage(socket as unknown as WebSocket,
        JSON.stringify(parsed.kind==='read'
          ? {kind:'read_result',request_id:parsed.request_id,status:'completed',text:'ok'}
          : {kind:'operation_result',request_id:parsed.request_id,
              result:{operation_id:parsed.operation_id,status:'completed'}}));});
    },
    close(){},
  };
  const storage={
    get:async (key:string)=>rows.get(key),
    list:async ({prefix,limit}:{prefix:string;limit:number})=>new Map([...rows]
      .filter(([key])=>key.startsWith(prefix)).slice(0,limit)),
    delete:async (key:string)=>rows.delete(key),
  };
  const state=({storage,getWebSockets:(tag:string)=>tag==='device:'+device.device_id?[socket]:[]}) as unknown as DurableObjectState;
  owner=new V2OwnerCoordinator(state,{
    WORKFLOW_SESSION_AUTHORIZATION:{authorizeSessionAttempt:async()=>{
      admissions++;
      return admitted?decision:{allowed:false};
    }},
  });
  const send=async(path:string,payload:unknown)=>owner.fetch(new Request('https://v2.internal/'+path,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),
  }));
  const read={device_id:device.device_id,tool:'computer_status',arguments:{}};
  const operation={device_id:device.device_id,tool:'start_process',
    operation_id:crypto.randomUUID(),arguments:{command:'echo only-fixture'}};
  const first=await send('read',read);
  assert.equal(first.status,200);
  assert.equal((await first.json() as {text:string}).text,'ok');
  const second=await send('operation',operation);
  assert.equal(second.status,200);
  assert.equal((await second.json() as {status:string}).status,'completed');
  const listed=await send('devices',{});
  assert.equal(listed.status,200);
  assert.equal((await listed.json() as Array<{device_id:string}>).length,2);
  const oldFrames=sent.length;
  admitted=false; // Workflow cancellation already persisted before admission.
  assert.equal((await send('read',read)).status,503);
  assert.equal((await send('operation',operation)).status,503);
  const deniedList=await send('devices',{});
  assert.deepEqual((await deniedList.json() as Array<{device_id:string}>).map(x=>x.device_id),
    [personal.device_id]);
  assert.equal(sent.length,oldFrames,'cancelled Session sends no additional frames');
  assert.ok(admissions>=6,'every new admission reads Workflow independently');
});
