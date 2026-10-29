import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {afterEach,describe,expect,it} from 'vitest';
import type {Env} from '../../src/types.js';
import {withHyperdriveExecutionFence,withDisabledHyperdriveProbeFence} from '../../src/registry/inflight.js';

const opened:DatabaseSync[]=[];
afterEach(()=>{for(const db of opened.splice(0))db.close();});
function fixture(){
 const sql=new DatabaseSync(':memory:');opened.push(sql);
 for(const name of ['0001_connections.sql','0002_transport_and_retired_ids.sql','0003_hyperdrive_operations.sql'])
  sql.exec(readFileSync(new URL('../../migrations/'+name,import.meta.url),'utf8'));
 const statement=(query:string,args:unknown[]=[])=>({
  bind(...next:unknown[]){return statement(query,next)},
  async run(){const r=sql.prepare(query).run(...args as []);return {meta:{changes:r.changes}}},
  async first<T>(){return sql.prepare(query).get(...args as []) as T|null},
  async all<T>(){return {results:sql.prepare(query).all(...args as []) as T[]}}
 });
 const env={DB:{prepare:(query:string)=>statement(query)}} as unknown as Env;
 const insert=(id:string,transport:'hyperdrive'|'direct',status:'active'|'disabled'='active')=>{
  sql.prepare(`INSERT INTO database_connections
    (id,dialect,transport,status,ciphertext,key_id,config_id,binding_name,revision,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,2,1,1)`).run(id,'mysql',transport,status,transport==='direct'?'sealed':null,
      transport==='direct'?'key-one':null,transport==='hyperdrive'?'abc12345':null,
      transport==='hyperdrive'?'HYPERDRIVE_FENCE':null);
 };
 const count=(id:string)=> (sql.prepare('SELECT in_flight_count FROM database_connections WHERE id=?').get(id) as {in_flight_count:number}).in_flight_count;
 return {sql,env,insert,count};
}
describe('durable Hyperdrive request admission fence',()=>{
 it('holds one atomic count until a successful execution completes and prevents a disabled racing admission',async()=>{
  const f=fixture();f.insert('hd','hyperdrive');
  let resolve!: (value:string)=>void;
  const pending=new Promise<string>(r=>{resolve=r});
  const running=withHyperdriveExecutionFence(f.env,'hd',()=>pending);
  await new Promise(r=>setImmediate(r));
  expect(f.count('hd')).toBe(1);
  expect(()=>f.sql.prepare("DELETE FROM database_connections WHERE id='hd'").run()).toThrow(/execution still in flight/);
  expect(()=>f.sql.prepare("UPDATE database_connections SET config_id='other' WHERE id='hd'").run()).toThrow(/execution still in flight/);
  f.sql.prepare("UPDATE database_connections SET status='disabled',revision=revision+1 WHERE id='hd'").run();
  await expect(withHyperdriveExecutionFence(f.env,'hd',async()=> 'bad')).rejects.toMatchObject({code:'CONNECTION_DISABLED'});
  expect(f.count('hd')).toBe(1);
  resolve('done');expect(await running).toBe('done');expect(f.count('hd')).toBe(0);
 });
 it('never consumes a Direct slot and handles implicit single-connection admission',async()=>{
  const f=fixture();f.insert('plain','direct');
  expect(await withHyperdriveExecutionFence(f.env,undefined,async()=>42)).toBe(42);
  expect(f.count('plain')).toBe(0);
 });
 it('retains uncertain execution count rather than claiming drain after failure or timeout',async()=>{
  const f=fixture();f.insert('hd','hyperdrive');
  await expect(withHyperdriveExecutionFence(f.env,'hd',async()=>{throw Error('unknown network outcome')})).rejects.toThrow();
  expect(f.count('hd')).toBe(1);
 });
 it('accounts for disabled owner health probes without allowing ordinary disabled MCP SQL',async()=>{
  const f=fixture();f.insert('hd','hyperdrive','disabled');
  let release!:()=>void;
  const hold=new Promise<void>(r=>{release=r});
  const probe=withDisabledHyperdriveProbeFence(f.env,'hd',2,()=>hold);
  await new Promise(r=>setImmediate(r));
  expect(f.count('hd')).toBe(1);
  await expect(withHyperdriveExecutionFence(f.env,'hd',async()=>1)).rejects.toMatchObject({code:'CONNECTION_DISABLED'});
  release();await probe;expect(f.count('hd')).toBe(0);
 });
});


describe('concurrent execution accounting',()=>{
 it('never reports zero while another concurrent SQL execution is still outstanding',async()=>{
  const f=fixture();f.insert('hd','hyperdrive');
  let doneA!:()=>void,doneB!:()=>void;
  const a=new Promise<void>(resolve=>{doneA=resolve});
  const b=new Promise<void>(resolve=>{doneB=resolve});
  const first=withHyperdriveExecutionFence(f.env,'hd',()=>a);
  const second=withHyperdriveExecutionFence(f.env,'hd',()=>b);
  await new Promise(resolve=>setImmediate(resolve));
  expect(f.count('hd')).toBe(2);
  doneA();await first;expect(f.count('hd')).toBe(1);
  f.sql.prepare("UPDATE database_connections SET status='disabled',revision=revision+1 WHERE id='hd'").run();
  expect(()=>f.sql.prepare("DELETE FROM database_connections WHERE id='hd'").run()).toThrow(/execution still in flight/);
  doneB();await second;expect(f.count('hd')).toBe(0);
 });
 it('retains a positive count after an unexpected execution failure without automatic expiry',async()=>{
  const f=fixture();f.insert('hd','hyperdrive');
  await expect(withHyperdriveExecutionFence(f.env,'hd',async()=>{throw Error('network outcome unknown');})).rejects.toThrow();
  expect(f.count('hd')).toBe(1);
  const row=f.sql.prepare('SELECT in_flight_count FROM database_connections WHERE id=?').get('hd');
  expect(row).toEqual({in_flight_count:1});
 });
});
