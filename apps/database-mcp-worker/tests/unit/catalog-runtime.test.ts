import {expect,it,vi} from 'vitest';
import {queryRead} from '../../src/db/index.js';
vi.mock('../../hyperdrive-bindings.json',()=>({default:[{binding:'HYPERDRIVE_MYSQL',id:'12345678-1234-1234-1234-123456789abc',dialect:'mysql',origin_database:'origin_schema'},{binding:'HYPERDRIVE_PG',id:'22345678-1234-1234-1234-123456789abc',dialect:'postgres'}]}));
vi.mock('../../src/db/index.js',async original=>({...await original<Record<string,unknown>>(),queryRead:vi.fn()}));
import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import worker from '../../src/index.js';
import type {Env} from '../../src/types.js';

async function clientFor(catalog: string, extra: Record<string,unknown> = {}) {
  const env = {DATABASE_CONNECTIONS:catalog, MCP_ACCESS_TOKEN:'synthetic-token',
    DATABASE_B2B_PASSWORD:'synthetic@/%:password', RATE_LIMITER:{limit:async()=>({success:true})}, ...extra} as Env;
  const transport = new StreamableHTTPClientTransport(new URL('https://synthetic.invalid/mcp'),{
    requestInit:{headers:{Authorization:'Bearer synthetic-token'}},
    fetch:async(input,init)=>worker.fetch(new Request(input,init),env,{} as ExecutionContext)
  });
  const client = new Client({name:'catalog-regression',version:'1'});
  await client.connect(transport);
  return client;
}
it('lists a Direct inventory through authenticated MCP without D1 or disclosing credentials',async()=>{
  const client=await clientFor('{"b2b":"mysql://user:${DATABASE_B2B_PASSWORD}@8.8.8.8:3306/b2b"}');
  try {
    const result=await client.callTool({name:'list_connections',arguments:{}});
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain('b2b');
    expect(JSON.stringify(result)).not.toContain('password');
    expect(JSON.stringify(result)).not.toContain('8.8.8.8');
  } finally {await client.close();}
});

it.each([
  '[]', '{"b2b":"mysql://user:literal@8.8.8.8/db"}',
  '{"b2b":"mysql://user:${UNAPPROVED}@8.8.8.8/db"}',
  '{"b2b":"mysql://user:${DATABASE_B2B_PASSWORD}@8.8.8.8/db","b2b":"mysql://user:${DATABASE_B2B_PASSWORD}@8.8.8.8/db"}',
  '{"b2b":"mysql://user:${DATABASE_B2B_PASSWORD}@8.8.8.8/db#fragment"}',
  '{"b2b":"hyperdrive://UNREVIEWED"}',
])('rejects malformed or unapproved configuration without leaking values: %s',async catalog=>{
  const client=await clientFor(catalog);
  try {
    const result=await client.callTool({name:'list_connections',arguments:{}});
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('CONFIGURATION_UNAVAILABLE');
    expect(JSON.stringify(result)).not.toContain('literal');
  } finally {await client.close();}
});
it.each(['/setup','/setup/connections','/internal/hyperdrive-health'])('retires management endpoint %s',async path=>{
  expect((await worker.fetch(new Request('https://synthetic.invalid'+path),{} as Env,{} as ExecutionContext)).status).toBe(404);
});

it('encodes reserved password characters, resolves Variables before URL parsing, and retains SQL guards',async()=>{
  vi.mocked(queryRead).mockResolvedValue({columns:[{name:'v'}],rows:[[1]],rowCount:1,truncated:false});
  const client=await clientFor('{"b2b":"mysql://user:${DATABASE_B2B_PASSWORD}@#{DB_HOST}:3306/b2b"}',{DB_HOST:'8.8.8.8'});
  try {
    const result=await client.callTool({name:'query_read',arguments:{connection:'b2b',sql:'SELECT 1'}});
    expect(result.isError).not.toBe(true);
    expect(vi.mocked(queryRead).mock.calls.at(-1)?.[0]).toMatchObject({password:'synthetic@/%:password',host:'8.8.8.8',dialHost:'8.8.8.8'});
    const rejected=await client.callTool({name:'query_read',arguments:{connection:'b2b',sql:'DELETE FROM users'}});
    expect(rejected.isError).toBe(true);
    expect(queryRead).toHaveBeenCalledTimes(1);
    const unknown=await client.callTool({name:'health_check',arguments:{connection:'removed'}});
    expect(JSON.stringify(unknown)).toContain('CONNECTION_NOT_FOUND');
  } finally {await client.close();vi.clearAllMocks();}
});
it('requires explicit selection for multiple configured IDs',async()=>{
  const uri='mysql://user:${DATABASE_B2B_PASSWORD}@8.8.8.8/db';
  const client=await clientFor(JSON.stringify({one:uri,two:uri}));
  try {expect(JSON.stringify(await client.callTool({name:'health_check',arguments:{}}))).toContain('INVALID_INPUT');}
  finally {await client.close();}
});

it('routes reviewed Hyperdrive bindings using proxy credentials and origin MySQL schema without D1',async()=>{
  vi.mocked(queryRead).mockResolvedValue({columns:[],rows:[],rowCount:0,truncated:false});
  const proxy={host:'proxy.internal',port:3306,user:'proxy-user',password:'proxy-secret',database:'opaque_proxy',connectionString:'mysql://proxy'};
  const client=await clientFor('{"analytics":"hyperdrive://HYPERDRIVE_MYSQL"}',{HYPERDRIVE_MYSQL:proxy});
  try {
    expect((await client.callTool({name:'query_read',arguments:{sql:'SELECT 1'}})).isError).not.toBe(true);
    expect(vi.mocked(queryRead).mock.calls.at(-1)?.[0]).toMatchObject({dialect:'mysql',database:'origin_schema',proxyDatabase:'opaque_proxy',password:'proxy-secret'});
    vi.mocked(queryRead).mockRejectedValueOnce(new Error('synthetic upstream raw secret'));
    const unknown=await client.callTool({name:'query_read',arguments:{sql:'SELECT 1'}});
    expect(unknown.isError).toBe(true);
    expect(JSON.stringify(unknown)).not.toContain('upstream raw secret');
    expect(queryRead).toHaveBeenCalledTimes(2); // one explicit invocation per request, no replay
  } finally {await client.close();vi.clearAllMocks();}
});
it('rejects a reviewed but missing Hyperdrive runtime binding before SQL',async()=>{
  const client=await clientFor('{"analytics":"hyperdrive://HYPERDRIVE_MYSQL"}');
  try {expect(JSON.stringify(await client.callTool({name:'query_read',arguments:{sql:'SELECT 1'}}))).toContain('CONFIGURATION_UNAVAILABLE');expect(queryRead).not.toHaveBeenCalled();}
  finally {await client.close();}
});
