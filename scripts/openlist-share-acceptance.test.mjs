import test from 'node:test';
import assert from 'node:assert/strict';
import { runOpenListOneShotShareAcceptance } from './openlist-share-acceptance.mjs';

const env={OPENLIST_SHARE_ACCEPTANCE_APPROVED:'true',
  OPENLIST_ALLOWED_ROOTS:'["/Koofr/Downloads"]',MCP_ACCESS_TOKEN:'fixture-secret'};
const ID='mcp_spec309_40493124967_1';
const FILE='/Koofr/Downloads/mcp-spec309-e2e-40493124967-1/sample-40493124967-1.txt';
const expires='2026-11-02T00:00:00.000Z';
const envelope=(name,target)=>Response.json({jsonrpc:'2.0',id:1,result:{
  content:[{type:'text',text:JSON.stringify({
    operation:name,status:'succeeded',code:'OK',target,
    observed_state:{id:ID,files:[FILE],disabled:false,max_accessed:1,expires}
  })}]
}});
test('share acceptance uses exactly one creation and one explicit-ID read',async()=>{
  const calls=[];
  const result=await runOpenListOneShotShareAcceptance(env,async req=>{
    const json=await req.json();const{name,arguments:args}=json.params;
    calls.push({name,args,origin:new URL(req.url).origin,method:req.method,auth:req.headers.get('authorization')});
    return envelope(name,ID);
  });
  assert.equal(result.id,ID);
  assert.deepEqual(calls.map(x=>({name:x.name,args:x.args})),[
    {name:'openlist_share_create',args:{}},
    {name:'openlist_share_get',args:{id:ID}},
  ]);
  for(const c of calls){
    assert.equal(c.origin,'https://openlist-mcp-worker.aiyaya.workers.dev');
    assert.equal(c.method,'POST');
    assert.equal(c.auth,'Bearer fixture-secret');
  }
});
test('share acceptance refuses any missing permission before dispatch',async()=>{
  for(const broken of [
    {...env,OPENLIST_SHARE_ACCEPTANCE_APPROVED:'false'},
    {...env,OPENLIST_ALLOWED_ROOTS:'["/Koofr"]'},
    {...env,MCP_ACCESS_TOKEN:''},
  ]){
    let calls=0;
    await assert.rejects(runOpenListOneShotShareAcceptance(broken,async()=>{
      calls++;return Response.json({});
    }),/openlist_share_acceptance_/);
    assert.equal(calls,0);
  }
});
test('share acceptance never retries unknown creation response',async()=>{
  let count=0;
  await assert.rejects(runOpenListOneShotShareAcceptance(env,async()=>{
    count++;
    return Response.json({jsonrpc:'2.0',id:1,result:{isError:true,content:[{
      type:'text',text:JSON.stringify({operation:'openlist_share_create',
        status:'unknown',code:'UPSTREAM_UNCERTAIN',target:ID})}]}});
  }),/openlist_share_acceptance_tool_not_confirmed/);
  assert.equal(count,1);
});
