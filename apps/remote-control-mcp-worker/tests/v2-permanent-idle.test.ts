import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { newEnrollment } from '../../remote-control-agent/src/v2-enrollment.ts';
import { signedSessionProof } from '../../remote-control-agent/src/v2-session-client.ts';
import { V2OwnerCoordinator } from '../src/worker.ts';
import { issueSessionChallenge, authorizeSocketSession, deviceIsAuthorized, parsePermanentIdleMs, handleIdleSocketMessage } from '../src/v2-session.ts';

const DAY = 86_400_000;

test('legacy offline grant migrates once, signed online reset cancels deadline, stale socket cannot revive at expiry', async () => {
  const original = Date.now;
  let clock = 1_800_000_000_000;
  Date.now = () => clock;
  try {
    const id = randomUUID();
    const identity = newEnrollment('lease-client');
    const rows = new Map<string, unknown>([['device:' + id, {
      device_id: id, name: 'lease-client', revoked: false,
      approved_at: clock - 60 * DAY, public_key: identity.request.public_key,
      fingerprint: 'a'.repeat(24),
    }]]);
    const memory = {
      get: async <T>(key: string) => rows.get(key) as T | undefined,
      put: async (key: string, value: unknown) => { rows.set(key, value); },
      delete: async (key: string) => rows.delete(key),
      list: async <T>({prefix,limit}: {prefix:string;limit:number}) => new Map([...rows].filter(([k])=>k.startsWith(prefix)).slice(0,limit)) as Map<string,T>,
    };
    const storage = { ...memory, transaction: async <T>(fn: (tx: typeof memory)=>Promise<T>) => fn(memory) };
    let sockets: WebSocket[] = [];
    const owner = new V2OwnerCoordinator({storage,getWebSockets:()=>sockets} as unknown as DurableObjectState);
    const list = async () => {
      const r = await owner.fetch(new Request('https://v2.internal/devices',{
        method:'POST',headers:{'content-type':'application/json'},body:'{}',
      }));
      assert.equal(r.status,200);
      return (await r.json() as Array<{device_id:string;idle_expires_at?:number;status:string}>)[0];
    };
    assert.equal((await list())?.idle_expires_at, clock + 14 * DAY);
    clock += DAY;
    assert.equal((await list())?.idle_expires_at, clock + 13 * DAY, 'listing must not renew migration deadline');
    const ch = await issueSessionChallenge(storage as never,{device_id:id});
    assert.equal(ch.status,200);
    const nonce = (ch.body as {nonce:string}).nonce;
    const proof = signedSessionProof(identity.privateKeyPem,id,nonce).proof;
    const current = await authorizeSocketSession(storage as never,{device_id:id,nonce,proof});
    assert.ok(current);
    sockets = [{ readyState: 1, deserializeAttachment: () => ({ device_id:id,epoch:current!.epoch }) } as unknown as WebSocket];
    assert.equal((await list())?.idle_expires_at, undefined,'authenticated online resets countdown');
    sockets = [];
    clock += 3 * DAY;
    assert.equal((await list())?.idle_expires_at, clock + 11 * DAY, 'silence cannot extend the last verified online checkpoint');
    clock += 11 * DAY;
    assert.equal((await issueSessionChallenge(storage as never,{device_id:id})).status,404,'expiry boundary is strict');
    assert.equal((await list()),undefined,'expired grant is not selectable');
  } finally { Date.now = original; }
});


test('RCA server validates idle setting and corrupt durable grants fail closed', () => {
  assert.equal(parsePermanentIdleMs(undefined), 14 * DAY);
  assert.equal(parsePermanentIdleMs(''), 14 * DAY);
  assert.equal(parsePermanentIdleMs('1'), DAY);
  assert.equal(parsePermanentIdleMs('90'), 90 * DAY);
  for (const invalid of ['0','91','01',' 7','7.5','-1','1e2',1,null]) {
    assert.throws(() => parsePermanentIdleMs(invalid), /RCA_PERMANENT_IDLE_DAYS/);
  }
  assert.throws(() => new V2OwnerCoordinator({} as DurableObjectState, {RCA_PERMANENT_IDLE_DAYS:'91'}), /RCA_PERMANENT_IDLE_DAYS/);
  const now = Date.now();
  const normal = {device_id:randomUUID(),name:'bad-checkpoint',public_key:'x',fingerprint:'f',approved_at:now,revoked:false as const,grant_type:'permanent' as const};
  for (const corrupt of [
    {idle_expires_at:'invalid'}, {last_verified_online_at:now+1000,idle_window_ms:14*DAY},
    {last_verified_online_at:now,idle_window_ms:91*DAY},
    {idle_expires_at:NaN}, {idle_window_ms:DAY},
  ]) assert.equal(deviceIsAuthorized({...normal,...corrupt} as never,now),false);
});

test('configured migration window is frozen for an already-offline grant', async () => {
  const now = Date.now(),id = randomUUID();
  const rows = new Map<string,unknown>([['device:'+id,{device_id:id,name:'old',public_key:'key',revoked:false}]]);
  const storage = {
    get: async <T>(k:string) => rows.get(k) as T,
    put: async (k:string,v:unknown) => {rows.set(k,v)},
    delete: async (k:string) => rows.delete(k),
    list: async <T>({prefix,limit}:{prefix:string;limit:number}) => new Map([...rows].filter(([k])=>k.startsWith(prefix)).slice(0,limit)) as Map<string,T>,
  };
  const state = {storage,getWebSockets:()=>[]} as unknown as DurableObjectState;
  const list = (owner:V2OwnerCoordinator) => owner.fetch(new Request('https://owner.test/devices',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}));
  const oneDay = new V2OwnerCoordinator(state,{RCA_PERMANENT_IDLE_DAYS:'1'});
  const data = await (await list(oneDay)).json() as Array<{idle_expires_at:number}>;
  assert.ok(data[0]!.idle_expires_at >= now + DAY && data[0]!.idle_expires_at <= now + DAY + 100);
  const twoWeeks = new V2OwnerCoordinator(state,{RCA_PERMANENT_IDLE_DAYS:'14'});
  const same = await (await list(twoWeeks)).json() as Array<{idle_expires_at:number}>;
  assert.equal(same[0]!.idle_expires_at,data[0]!.idle_expires_at,'release variable change cannot silently extend a durable deadline');
});


test('server-verified epoch probes hold idle-free online for 31 days, stale socket cannot renew',async()=>{
 const original=Date.now;
 let now=1_830_000_000_000;Date.now=()=>now;
 try{
  const id=randomUUID(),epoch=randomUUID(),initial={device_id:id,name:'online',public_key:'key',
   fingerprint:'f'.repeat(24),approved_at:now,revoked:false,grant_type:'permanent',
   last_verified_online_at:now,idle_window_ms:14*DAY};
  const rows=new Map<string,unknown>([['device:'+id,initial],['session:epoch:'+id,epoch]]);
  const storage={get:async<T>(key:string)=>rows.get(key) as T,
   put:async(key:string,v:unknown)=>{rows.set(key,v);},delete:async(key:string)=>rows.delete(key)};
  const state={storage:{...storage,transaction:async<T>(fn:(tx:typeof storage)=>Promise<T>)=>fn(storage)}} as unknown as DurableObjectState;
  let attachment={device_id:id,epoch,last_auth_check_at:0};
  let successful=0,closed=0;
  const socket={deserializeAttachment:()=>attachment,serializeAttachment:(value:typeof attachment)=>{attachment=value},
   send:()=>{successful++},close:()=>{closed++}} as unknown as WebSocket;
  for(let i=0;i<31*24*4;i++){
   now+=15*60_000;
   await handleIdleSocketMessage(state,socket,'rc-v2:auth:'+'a'.repeat(32));
  }
  assert.equal(successful,31*24*4);
  assert.equal(closed,0);
  const row=rows.get('device:'+id) as {last_verified_online_at:number;idle_expires_at?:number};
  assert.equal(row.last_verified_online_at,now);
  assert.equal(row.idle_expires_at,undefined);
  assert.equal(deviceIsAuthorized(row as never,now),true);
  // A stale socket can mutate the unauthenticated attachment rate gate, not trusted evidence.
  rows.set('session:epoch:'+id,randomUUID());
  now+=15*60_000;
  await handleIdleSocketMessage(state,socket,'rc-v2:auth:'+'b'.repeat(32));
  assert.equal(closed,1);
  assert.equal((rows.get('device:'+id) as typeof row).last_verified_online_at,now-15*60_000);
  now+=14*DAY;
  assert.equal(deviceIsAuthorized(rows.get('device:'+id) as never,now),false);
 }finally{Date.now=original;}
});
