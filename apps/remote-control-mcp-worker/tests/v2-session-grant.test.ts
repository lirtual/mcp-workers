import test from 'node:test';
import assert from 'node:assert/strict';
import {deviceIsAuthorized,listApprovedDevices,type V2Device} from '../src/v2-session.ts';
const now=Date.now();
const session={
  device_id:'123e4567-e89b-42d3-a456-426614174001',name:'session-ubuntu',
  public_key:'a'.repeat(60),fingerprint:'ff'.repeat(12),
  approved_at:now-30_000,revoked:false as const,
  grant_type:'session' as const,expires_at:now+60_000,
  session_attempt_id:'123e4567-e89b-42d3-a456-426614174002',
  session_run_id:8765,session_run_attempt:2,session_workflow_name:'ubuntu' as const,
};
test('Session grant is never permanent and never survives its own deadline',()=>{
  assert.equal(deviceIsAuthorized(session),true);
  assert.equal(deviceIsAuthorized(session,session.expires_at),false);
  assert.equal(deviceIsAuthorized({...session,expires_at:undefined}),false);
  assert.equal(deviceIsAuthorized({...session,session_attempt_id:undefined}),false);
  assert.equal(deviceIsAuthorized({...session,grant_type:'unknown'} as never),false);
});
test('temporary and permanent grants retain their established local semantics',()=>{
  assert.equal(deviceIsAuthorized({...session,grant_type:'permanent',last_verified_online_at:now,idle_window_ms:14*86_400_000}),true);
  assert.equal(deviceIsAuthorized({...session,grant_type:'temporary'}),false);
});
test('Session devices are only listed after fresh workflow approval and do not affect personal devices',async()=>{
  const personal={...session,device_id:'123e4567-e89b-42d3-a456-426614174003',
    grant_type:'permanent' as const,name:'personal',last_verified_online_at:now,idle_window_ms:14*86_400_000};
  const values=new Map<string,V2Device>([['device:'+session.device_id,session],['device:'+personal.device_id,personal]]);
  const storage={list:async()=>values,delete:async()=>true,
    get:async()=>undefined};
  const state={storage,getWebSockets:()=>[]} as any;
  let calls=0;
  const denied=await listApprovedDevices(state,async()=>{calls++;return false});
  assert.equal(denied.status,200);
  assert.deepEqual((denied.body as any[]).map(d=>d.device_id),[personal.device_id]);
  assert.equal(calls,1);
  const allowed=await listApprovedDevices(state,async()=>true);
  assert.equal((allowed.body as any[]).length,2);
});
test('Workflow RPC outage hides only Session devices, not personal permanent devices',async()=>{
  const personal={...session,device_id:'123e4567-e89b-42d3-a456-426614174003',
    grant_type:'permanent' as const,name:'personal',last_verified_online_at:now,idle_window_ms:14*86_400_000};
  const values=new Map<string,V2Device>([['device:'+session.device_id,session],['device:'+personal.device_id,personal]]);
  const state={storage:{list:async()=>values,delete:async()=>true,get:async()=>undefined},
    getWebSockets:()=>[]} as any;
  const result=await listApprovedDevices(state,async()=>{throw Error('rpc unavailable')});
  assert.equal(result.status,200);
  assert.deepEqual((result.body as any[]).map(d=>d.device_id),[personal.device_id]);
});
