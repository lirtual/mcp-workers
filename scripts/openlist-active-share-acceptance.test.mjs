import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runActiveShareAcceptance} from './openlist-active-share-acceptance.mjs';

const FILE='/Koofr/Downloads/mcp-spec309-e2e-40493124967-1/sample-40493124967-1.txt';
const MCP='https://openlist-mcp-worker.aiyaya.workers.dev/mcp';
const CREATE='https://openlist.lirtual.dpdns.org/api/share/create';
const PUBLIC='https://openlist.lirtual.dpdns.org/api/fs/get';
const uuid='12345678-1234-4123-8123-123456789abc';
const id='mcp_spec309_live_1234567812344123';
const env={
  OPENLIST_ACTIVE_SHARE_APPROVED:'true',
  GITHUB_RUN_ID:'40610012345',GITHUB_RUN_ATTEMPT:'1',
  MCP_ACCESS_TOKEN:'synthetic-mcp-credential',
  OPENLIST_API_TOKEN:'synthetic-upstream-credential',
  OPENLIST_ALLOWED_ROOTS:'["/Koofr/Downloads"]',
};
const reply = obj => new Response(JSON.stringify(obj),{
  status:200,headers:{'content-type':'application/json'}});
const rpc = (name,observed_state,status='succeeded',code='OK',isError=false) => reply({
  jsonrpc:'2.0',id:1,result:{...(isError?{isError:true}:{}),
    content:[{type:'text',text:JSON.stringify({
      operation:name,status,code,
      target:name==='openlist_get_file'?FILE:id,
      ...(observed_state?{observed_state}:{}),
    })}]},
});
function transportFactory({unknownDisable=false,createFails=false,postDenial='disabled'}={}){
  const state={reads:0,creates:0,disables:0,publicValid:0,publicWrong:0,
    id,expires:null,pwd:null,disabled:false,created:false};
  const transport=async req=>{
    assert.equal(req.method,'POST');
    assert.equal(req.redirect,'manual');
    const body=await req.json();
    if(req.url===CREATE){
      state.creates++;
      assert.equal(req.headers.get('authorization'),env.OPENLIST_API_TOKEN);
      assert.equal(body.id,id);
      assert.deepEqual(body.files,[FILE]);
      assert.equal(body.max_accessed,1);
      assert.equal(body.disabled,false);
      assert.match(body.pwd,/^[a-f0-9]{64}$/);
      const expires=new Date(body.expires).getTime();
      assert.ok(expires>Date.now()+3500_000 && expires<Date.now()+3650_000);
      state.created=true;state.expires=body.expires;state.pwd=body.pwd;
      if(createFails)throw Error('create response lost');
      return reply({code:200,data:{id}});
    }
    if(req.url===PUBLIC){
      assert.equal(req.headers.has('authorization'),false);
      assert.equal(body.path,'/@s/'+id);
      if(body.password!==state.pwd){
        state.publicWrong++;
        return reply({code:400,message:'wrong password',data:null});
      }
      if(state.disabled)return reply({code:400,message:'share has been disabled',data:null});
      if(state.publicValid>=1)return reply({code:400,message:'share access count exceeded',data:null});
      state.publicValid++;
      return reply({code:200,message:'success',data:{
        name:'sample-40493124967-1.txt',size:50,is_dir:false}});
    }
    assert.equal(req.url,MCP);
    assert.equal(req.headers.get('authorization'),'Bearer '+env.MCP_ACCESS_TOKEN);
    const name=body.params.name,args=body.params.arguments;
    if(name==='openlist_get_file'){
      assert.deepEqual(args,{path:FILE});
      return rpc(name,{path:FILE,name:'sample-40493124967-1.txt',
        size:50,is_dir:false});
    }
    assert.equal(args.id,id);
    if(name==='openlist_share_get'){
      state.reads++;
      if(!state.created)return rpc(name,null,'not_executed','NOT_FOUND',true);
      return rpc(name,{
        id,files:[FILE],disabled:state.disabled,expires:state.expires,
        max_accessed:1,
      });
    }
    if(name==='openlist_share_disable'){
      assert.equal(state.disables++,0,'must not retry');
      state.disabled=true;
      if(unknownDisable)return rpc(name,null,'unknown','UPSTREAM_UNCERTAIN',true);
      return rpc(name,{disabled:true});
    }
    assert.fail('unexpected MCP tool '+name);
  };
  return {state,transport};
}

test('one approved share with password and max_accessed=1 is created, accessible, disabled and denied with explicit disabled reason',async()=>{
  const {state,transport}=transportFactory();
  const result=await runActiveShareAcceptance(env,transport,()=>uuid,b=>b.fill(7));
  assert.deepEqual({id:result.id,created:result.createConfirmed,disabled:result.afterState,
    validBefore:result.beforePublic,deniedAfter:result.publicAfterDisabled,
    rejection:result.publicRejection},
    {id,created:true,disabled:true,validBefore:true,deniedAfter:true,
      rejection:'disabled'});
  assert.equal(state.creates,1);
  assert.equal(state.disables,1);
  assert.equal(state.publicWrong,1);
  assert.equal(state.publicValid,1);
  assert.ok(state.reads>=4);
});

test('lost create response is inspected read-only, but no creation is retried',async()=>{
  const {state,transport}=transportFactory({createFails:true});
  await assert.rejects(runActiveShareAcceptance(env,transport,()=>uuid,b=>b.fill(7)),
    /^Error: openlist_active_share_public_probe_failed/);
  assert.equal(state.creates,1);
  assert.equal(state.disables,1);
  assert.equal(state.publicValid,0);
});

test('unknown disable response is never replayed even when independent state becomes disabled',async()=>{
  const {state,transport}=transportFactory({unknownDisable:true});
  await assert.rejects(runActiveShareAcceptance(env,transport,()=>uuid,b=>b.fill(7)),
    /^Error: openlist_active_share_disable_rpc_unknown/);
  assert.equal(state.creates,1);
  assert.equal(state.disables,1);
  assert.equal(state.disabled,true);
});

test('approval, exact roots, separate token and first run attempt fail before any network',async()=>{
  for(const overrides of [
    {OPENLIST_ACTIVE_SHARE_APPROVED:'false'},
    {GITHUB_RUN_ATTEMPT:'2'},
    {OPENLIST_ALLOWED_ROOTS:'["/Koofr/elsewhere"]'},
    {OPENLIST_ALLOWED_ROOTS:'[]'},
    {MCP_ACCESS_TOKEN:''},
    {OPENLIST_API_TOKEN:env.MCP_ACCESS_TOKEN},
    {OPENLIST_HISTORICAL_SHARE_READ:'true'},
  ]){
    let calls=0;
    await assert.rejects(runActiveShareAcceptance({...env,...overrides},
      async()=>{calls++;throw Error('unexpected network')},()=>uuid,b=>b.fill(7)),
      /^Error: openlist_active_share_/);
    assert.equal(calls,0);
  }
});

test('manual one-shot workflow is exclusive, no Worker publication, no general share creation',async()=>{
  const workflow=await readFile(new URL('../.github/workflows/openlist-acceptance.yml',import.meta.url),'utf8');
  assert.match(workflow,/confirm_active_share_one_shot:/);
  assert.match(workflow,/APPROVE_ACTIVE_SHARE: \${{ inputs.confirm_active_share_one_shot }}/);
  assert.match(workflow,/\$APPROVE_ACTIVE_SHARE" == "true"/);
  assert.match(workflow,/inputs.confirm_active_share_one_shot == true/);
  assert.match(workflow,/GITHUB_RUN_ATTEMPT.*1/);
  assert.match(workflow,/OPENLIST_ACTIVE_SHARE_APPROVED: "true"/);
  assert.match(workflow,/node --test scripts\/openlist-active-share-acceptance.test.mjs/);
  assert.match(workflow,/run: node scripts\/openlist-active-share-acceptance.mjs/);
  assert.match(workflow,/cancel-in-progress: false/);
});
