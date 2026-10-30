import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {createMcpHandler} from '@modelcontextprotocol/server';
import {buildMcpServer} from '../../src/mcp.js';
import {ConfirmedReadFailure} from '../../src/db/completion.js';
import {queryRead,healthCheck,insertRows} from '../../src/db/index.js';
import type {Env} from '../../src/types.js';

vi.mock('../../src/db/index.js',async importOriginal=>({
  ...await importOriginal<Record<string,unknown>>(),
  queryRead:vi.fn(),healthCheck:vi.fn(),insertRows:vi.fn()
}));

const openDbs:DatabaseSync[]=[];
afterEach(()=>{for(const sql of openDbs.splice(0))sql.close();vi.resetAllMocks();});
beforeEach(()=>{
  vi.clearAllMocks();
  vi.mocked(queryRead).mockResolvedValue({
  columns:[{name:'value'}],rows:[[7]],rowCount:1,truncated:false
  });
});
function fixture(){
  const sql=new DatabaseSync(':memory:');openDbs.push(sql);
  for(const name of ['0001_connections.sql','0002_transport_and_retired_ids.sql','0003_hyperdrive_operations.sql'])
    sql.exec(readFileSync(new URL('../../migrations/'+name,import.meta.url),'utf8'));
  sql.prepare(`INSERT INTO database_connections
    (id,dialect,transport,status,config_id,binding_name,revision,created_at,updated_at)
    VALUES ('synthetic_hd','mysql','hyperdrive','active',
      '38bf39b569484dbb8a9fe1b24f0df854','HYPERDRIVE_DB344_MYSQL_E2E',1,1,1)`).run();
  const stmt=(query:string,args:unknown[]=[])=>({
    bind(...next:unknown[]){return stmt(query,next)},
    async run(){const result=sql.prepare(query).run(...args as []);return {meta:{changes:result.changes}}},
    async first<T>(){return sql.prepare(query).get(...args as []) as T|null},
    async all<T>(){return {results:sql.prepare(query).all(...args as []) as T[]}}
  });
  const env={DB:{prepare:(query:string)=>stmt(query)},RATE_LIMITER:{limit:async()=>({success:true})},
    HYPERDRIVE_DB344_MYSQL_E2E:{
      connectionString:'mysql://synthetic:synthetic@proxy.example.test:3306/synthetic_proxy',
      host:'proxy.example.test',port:3306,user:'synthetic',password:'synthetic',database:'synthetic_proxy'
    }
  } as unknown as Env;
  const count=()=>(sql.prepare("SELECT in_flight_count FROM database_connections WHERE id='synthetic_hd'").get() as {in_flight_count:number}).in_flight_count;
  return {sql,env,count};
}
async function clientFor(env:Env){
  const handler=createMcpHandler(()=>buildMcpServer(env),{legacy:'stateless'});
  const transport=new StreamableHTTPClientTransport(new URL('https://synthetic.invalid/mcp'),{
    fetch:async(input,init)=>handler.fetch(input instanceof Request?input:new Request(input,init),{
      authInfo:{token:'synthetic-test-only',clientId:'test-owner',scopes:[]}
    })
  });
  const client=new Client({name:'synthetic-drain-regression',version:'0.1.0'});
  await client.connect(transport);
  return client;
}
const query={name:'query_read',arguments:{connection:'synthetic_hd',sql:'SELECT 7 AS value',params:[]}};

it('real MCP HTTP protocol holds D1 claim across SQL and rejects new SQL after disable',async()=>{
  const f=fixture();const client=await clientFor(f.env);
  try{
    let resolve!: (result:Awaited<ReturnType<typeof queryRead>>)=>void;
    const pending=new Promise<Awaited<ReturnType<typeof queryRead>>>(r=>{resolve=r});
    vi.mocked(queryRead).mockImplementationOnce(()=>pending);
    const running=client.callTool(query);
    for(let i=0;i<100 && f.count()!==1;i++)await new Promise(r=>setTimeout(r,3));
    expect(f.count()).toBe(1);
    expect(queryRead).toHaveBeenCalledOnce();
    f.sql.prepare("UPDATE database_connections SET status='disabled',revision=revision+1 WHERE id='synthetic_hd'").run();
    const denied=await client.callTool(query);
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).toContain('CONNECTION_DISABLED');
    expect(queryRead).toHaveBeenCalledOnce();
    expect(f.count()).toBe(1);
    resolve({columns:[{name:'value'}],rows:[[7]],rowCount:1,truncated:false});
    const success=await running;
    expect(success.isError).not.toBe(true);
    expect(f.count()).toBe(0);
    expect(f.sql.prepare("SELECT revision FROM database_connections WHERE id='synthetic_hd'").get())
      .toEqual({revision:2});
  }finally{await client.close()}
});

it('MCP health tool claims and releases while read tool failures retain unresolved count',async()=>{
  const f=fixture();const client=await clientFor(f.env);
  try{
    vi.mocked(healthCheck).mockResolvedValue({ok:true,latencyMs:1});
    const health=await client.callTool({name:'health_check',arguments:{connection:'synthetic_hd'}});
    expect(health.isError).not.toBe(true);
    expect(f.count()).toBe(0);
    vi.mocked(queryRead).mockRejectedValueOnce(Error('synthetic unknown SQL outcome'));
    const bad=await client.callTool(query);
    expect(bad.isError).toBe(true);
    expect(f.count()).toBe(1);
    expect(()=>f.sql.prepare("DELETE FROM database_connections WHERE id='synthetic_hd'").run())
      .toThrow(/execution still in flight/);
  }finally{await client.close()}
});

it('real MCP HTTP recovers a failed read only after backend-confirmed rollback',async()=>{
  const f=fixture();const client=await clientFor(f.env);
  try{
    const rejection=Object.assign(new Error('missing table'),{code:'ER_NO_SUCH_TABLE'});
    vi.mocked(queryRead).mockRejectedValueOnce(new ConfirmedReadFailure(rejection));
    const failed=await client.callTool(query);
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed)).toContain('DATABASE_ERROR');
    expect(f.count()).toBe(0);
  }finally{await client.close();}
});

it('implicit single connection and list_connections use the correct admission mode',async()=>{
  const f=fixture();const client=await clientFor(f.env);
  try{
    const listed=await client.callTool({name:'list_connections',arguments:{}});
    expect(listed.isError).not.toBe(true);
    expect(f.count()).toBe(0);
    const read=await client.callTool({name:'query_read',arguments:{sql:'SELECT 7',params:[]}});
    expect(read.isError).not.toBe(true);
    expect(queryRead).toHaveBeenCalledOnce();
    expect(f.count()).toBe(0);
    f.sql.prepare("UPDATE database_connections SET status='disabled',revision=2 WHERE id='synthetic_hd'").run();
    const denied=await client.callTool({name:'query_read',arguments:{sql:'SELECT 7',params:[]}});
    expect(denied.isError).toBe(true);
    expect(queryRead).toHaveBeenCalledOnce();
  }finally{await client.close()}
});

it('structured MCP writes are also held until confirmed completion',async()=>{
  const f=fixture();const client=await clientFor(f.env);
  try{
    let resolve!: (result:{affectedRows:number})=>void;
    const pending=new Promise<{affectedRows:number}>(r=>{resolve=r});
    vi.mocked(insertRows).mockImplementationOnce(()=>pending);
    const written=client.callTool({name:'insert_rows',arguments:{connection:'synthetic_hd',table:'items',rows:[{id:1}]}});
    for(let i=0;i<100 && f.count()!==1;i++)await new Promise(r=>setTimeout(r,3));
    expect(f.count()).toBe(1);
    f.sql.prepare("UPDATE database_connections SET status='disabled',revision=2 WHERE id='synthetic_hd'").run();
    expect((await client.callTool({name:'insert_rows',arguments:{connection:'synthetic_hd',table:'items',rows:[{id:2}]}})).isError).toBe(true);
    expect(insertRows).toHaveBeenCalledOnce();
    resolve({affectedRows:1});
    expect((await written).isError).not.toBe(true);
    expect(f.count()).toBe(0);
  }finally{await client.close()}
});

it('invalid read SQL and parameters never acquire an in-flight claim or reach the database',async()=>{
  const f=fixture();const client=await clientFor(f.env);
  try {
    for(const arguments_ of [
      {connection:'synthetic_hd',sql:'UPDATE items SET id=1',params:[]},
      {connection:'synthetic_hd',sql:'SELECT 1; DELETE FROM items',params:[]},
      {connection:'synthetic_hd',sql:'SELECT SLEEP(3)',params:[]},
      {connection:'synthetic_hd',sql:'SELECT 7',params:[{unsupported:'complex'}]}
    ]) {
      const failed=await client.callTool({name:'query_read',arguments:arguments_});
      expect(failed.isError).toBe(true);
      expect(f.count()).toBe(0);
    }
    expect(queryRead).not.toHaveBeenCalled();
  }finally{await client.close()}
});
