import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import readonlyWorker from './fixtures/readonly-worker.ts';

test('S1 read-only target speaks real Streamable HTTP MCP through fixed fetch seam', async () => {
 const client=new Client({name:'s1-test',version:'0.1.0'});
 const transport=new StreamableHTTPClientTransport(new URL('https://s1-fixture.invalid/mcp'),{
   fetch: async (input, init) => readonlyWorker.fetch(new Request(input,init)),
 });
 try{
   await client.connect(transport);
   const response=await client.callTool({name:'echo',arguments:{value:'hello fixture'}});
   assert.equal(response.isError,undefined);
   assert.deepEqual(response.content,[{type:'text',text:'hello fixture'}]);
 }finally{await client.close();}
});
