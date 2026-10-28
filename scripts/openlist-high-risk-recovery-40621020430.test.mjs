import test from 'node:test';
import assert from 'node:assert/strict';
import {recover} from './openlist-high-risk-recovery-40621020430.mjs';
const ROOT='/Koofr/Downloads';
const FILE=ROOT+'/mcp-spec309-e2e-40621020430-1/sample-40621020430-1.txt';
const SHARE='1feb6d48e03b4b91';
const SIZE=new TextEncoder().encode('OpenList MCP Spec309 disposable E2E 40621020430-1\n').length;
const env={OPENLIST_SPEC309_RECOVERY_APPROVED:'true',OPENLIST_ALLOWED_ROOTS:JSON.stringify([ROOT]),
  GITHUB_RUN_ATTEMPT:'1',GITHUB_RUN_ID:'40621123456',MCP_ACCESS_TOKEN:'synthetic-ingress'};
const payload=(name,target,observed_state,isError=false,code='OK')=>Response.json({
  jsonrpc:'2.0',id:1,result:{...(isError?{isError:true}:{}),
  content:[{type:'text',text:JSON.stringify({operation:name,target,observed_state,
    status:isError?'not_executed':'succeeded',code})}]}
});
function fake({disabled=false,shareExists=true,fileExists=true,foreign=false}={}){
  const writes=[];
  const transport=async request=>{
    assert.equal(request.url,'https://openlist-mcp-worker.aiyaya.workers.dev/mcp');
    assert.equal(request.method,'POST');
    assert.equal(request.headers.get('authorization'),'Bearer '+env.MCP_ACCESS_TOKEN);
    const {params}=await request.json();
    const name=params.name,args=params.arguments;
    if(name==='openlist_share_get'){
      assert.deepEqual(args,{id:SHARE});
      if(!shareExists) return payload(name,SHARE,null,true,'NOT_FOUND');
      return payload(name,SHARE,{id:SHARE,files:[foreign?'/Koofr/elsewhere/u.txt':FILE],disabled});
    }
    if(name==='openlist_get_file'){
      assert.deepEqual(args,{path:FILE});
      if(!fileExists) return payload(name,FILE,null,true,'NOT_FOUND');
      return payload(name,FILE,{path:FILE,name:FILE.split('/').at(-1),is_dir:false,size:SIZE});
    }
    writes.push(name);
    if(name==='openlist_share_disable'){
      assert.deepEqual(args,{id:SHARE});assert.equal(disabled,false);disabled=true;
      return payload(name,SHARE,{disabled:true});
    }
    if(name==='openlist_share_revoke'){
      assert.deepEqual(args,{id:SHARE});assert.equal(disabled,true);shareExists=false;
      return payload(name,SHARE,{revoked:true});
    }
    if(name==='openlist_delete'){
      assert.deepEqual(args,{path:FILE});assert.equal(shareExists,false);
      fileExists=false;
      return payload(name,FILE,{deleted:true});
    }
    assert.fail('unapproved mutation '+name);
  };
  return {transport,writes};
}
test('one exact cleanup disables, revokes, verifies file kept, then deletes just synthetic file',async()=>{
  const {transport,writes}=fake();
  const result=await recover(env,transport,async()=>{});
  assert.deepEqual(result,{share_revoked:true,synthetic_file_deleted:true});
  assert.deepEqual(writes,['openlist_share_disable','openlist_share_revoke','openlist_delete']);
});
test('already disabled synthetic share never repeats disable',async()=>{
  const {transport,writes}=fake({disabled:true});
  await recover(env,transport,async()=>{});
  assert.deepEqual(writes,['openlist_share_revoke','openlist_delete']);
});
test('cross-root share or replay cannot ever dispatch a write',async()=>{
  for(const [config,overrides] of [
    [{foreign:true},{}],
    [{}, {GITHUB_RUN_ATTEMPT:'2'}],
    [{},{OPENLIST_ALLOWED_ROOTS:'["/Koofr/Downloads","/Koofr"]'}],
    [{},{OPENLIST_SPEC309_RECOVERY_APPROVED:'false'}],
  ]){
    const {transport,writes}=fake(config);
    await assert.rejects(recover({...env,...overrides},transport,async()=>{}),
      /^Error: openlist_recovery_/);
    assert.deepEqual(writes,[]);
  }
});
