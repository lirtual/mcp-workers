import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyActionsCutoverReadback as verify,verifyNativeInstanceResponse,
 checkNativeWorkflowDrain,NONTERMINAL_NATIVE_STATUSES,requireIngressQuiescence} from './actions-consumer-cutover-gate.mjs';
const old=[
 {name:'WEIXIN_ACTION_PROVIDER',type:'service',service:'weixin-mcp-worker',entrypoint:'WeixinActionProvider'},
 {name:'BARK_ACTION_PROVIDER',type:'service',service:'bark-provider',entrypoint:'BarkActionProvider'}
];
const unified=[{name:'ACTIONS',type:'service',service:'cloudflare-actions',entrypoint:'ActionsEntrypoint'}];
const db=gate_state=>[{success:true,results:[{gate_state}]}];
test('current release rejects old, mixed, extra or malformed Provider bindings',()=>{
 for(const bindings of [[],old,old.slice(0,1),[...old,...unified],
  [...unified,unified[0]],[...unified,{name:'EXTRA',type:'service',service:'other'}],
  [{...unified[0],service:'different'}],[{...unified[0],entrypoint:'different'}]])
  for(const state of ['open','frozen'])
   assert.throws(()=>verify(bindings,db(state)),/blocked/);
});
test('current unified releases verify the gate row without claiming physical drain',()=>{
 assert.deepEqual(verify(unified,db('open')),{gate:'open',physical_drain_proven:false});
 assert.deepEqual(verify(unified,db('frozen')),{gate:'frozen',physical_drain_proven:false});
 for(const bad of [[],[{success:false,results:[{gate_state:'frozen'}]}],db(null)])
  assert.throws(()=>verify(unified,bad),/blocked/);
});

test('native Workflow drain gate fails closed for live or incomplete status inventory',()=>{
 for(const status of NONTERMINAL_NATIVE_STATUSES){
  assert.equal(verifyNativeInstanceResponse(status,{
   success:true,result:[],result_info:{count:0,total_count:0,per_page:100}}),true);
  assert.equal(verifyNativeInstanceResponse(status,{success:true,result:[],result_info:{count:0}}),true);
  for(const value of [
   {success:true,result:[{id:'active'}],result_info:{count:1,total_count:1}},
   {success:true,result:[],result_info:{count:0,total_count:1}},
   {success:false,result:[],result_info:{count:0,total_count:0}},
   {success:true,result:[],result_info:{count:10,total_count:0}},
   {success:true,result:[],result_info:{count:0,total_count:0,cursor:'next-page'}},
   {success:true,result:[],result_info:{count:0,next_cursor:'next-page'}},
   {success:true,result:[],result_info:{count:0,total_pages:2}},
   {success:true,result:[],result_info:{count:0,total_count:-1}}
  ])assert.throws(()=>verifyNativeInstanceResponse(status,value),/blocked/);
 }
});
test('compatible native inventory permits only exact Ready instance IDs',()=>{
 const active={success:true,result:[{id:'ready-instance'}],result_info:{count:1,total_count:1}};
 assert.equal(verifyNativeInstanceResponse('running',active,['ready-instance']),true);
 assert.throws(()=>verifyNativeInstanceResponse('running',active,[]),/blocked/);
 assert.throws(()=>verifyNativeInstanceResponse('running',active,['other-instance']),/blocked/);
 assert.throws(()=>verifyNativeInstanceResponse('running',{...active,result_info:{...active.result_info,total_count:2}},['ready-instance']),/blocked/);
});
test('native preflight queries all nonterminal states; no deployment or mutation',async()=>{
 const requests=[];
 const fakeFetch=async url=>{
  requests.push(new URL(url));
  return {ok:true,json:async()=>({
   success:true,result:[],result_info:{count:0,total_count:0,per_page:100}
  })};
 };
 assert.equal(await checkNativeWorkflowDrain('f'.repeat(32),{authorization:'test'},fakeFetch),true);
 assert.deepEqual(requests.map(x=>x.searchParams.get('status')),[...NONTERMINAL_NATIVE_STATUSES]);
 assert.equal(requests.every(x=>x.pathname.endsWith('/instances')&&
   x.searchParams.get('per_page')==='100'),true);
});
test('first active native instance blocks transition without querying further statuses',async()=>{
 let queries=0;
 await assert.rejects(()=>checkNativeWorkflowDrain('f'.repeat(32),{},async()=>{
  queries++;
  return {ok:true,json:async()=>({success:true,result:[{id:'still-live'}],
   result_info:{count:1,total_count:1}})};
 }),/blocked/);
 assert.equal(queries,1);
});

test('first cutover explicitly rejects absent Owner ingress-quiescence attestation',()=>{
 for(const value of [undefined,'','false','yes','1'])assert.throws(
  ()=>requireIngressQuiescence(value),/quiescence/);
 assert.equal(requireIngressQuiescence('true'),true);
});
