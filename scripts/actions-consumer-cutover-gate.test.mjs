import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyActionsCutoverReadback as verify,verifyNativeInstanceResponse,
 checkNativeWorkflowDrain,NONTERMINAL_NATIVE_STATUSES,requireOldIngressQuiescence} from './actions-consumer-cutover-gate.mjs';
const old=[
 {name:'WEIXIN_ACTION_PROVIDER',type:'service',service:'weixin-mcp-worker',entrypoint:'WeixinActionProvider'},
 {name:'BARK_ACTION_PROVIDER',type:'service',service:'bark-provider',entrypoint:'BarkActionProvider'}
];
const unified=[{name:'ACTIONS',type:'service',service:'cloudflare-actions',entrypoint:'ActionsEntrypoint'}];
const db=gate_state=>[{success:true,results:[{gate_state}]}];
test('first old-to-unified release requires a real frozen D1 row',()=>{
 assert.deepEqual(verify(old,db('frozen')),{transition:'legacy_to_unified',gate:'frozen',physical_drain_proven:false});
 for(const value of ['open',null,undefined,'unknown'])
  assert.throws(()=>verify(old,db(value)),/blocked/);
 for(const bindings of [[],old.slice(0,1),[...old,...unified]])
  assert.throws(()=>verify(bindings,db('frozen')),/blocked/);
});
test('first release rejects service target or entrypoint drift even with correct names',()=>{
 for(const index of [0,1]){
  for(const field of ['service','entrypoint']){
   const broken=old.map((x,i)=>i===index?{...x,[field]:'different'}:x);
   assert.throws(()=>verify(broken,db('frozen')),/blocked/);
  }
  assert.throws(()=>verify([...old,old[index]],db('frozen')),/blocked/);
 }
 for(const field of ['service','entrypoint']){
  assert.throws(()=>verify([{...unified[0],[field]:'different'}],db('open')),/blocked/);
 }
});
test('repeat unified releases verify the row but do not need a permanent frozen gate',()=>{
 assert.deepEqual(verify(unified,db('open')),{transition:'already_unified',gate:'open',physical_drain_proven:false});
 for(const bad of [[],[{success:false,results:[{gate_state:'frozen'}]}],db(null)])
  assert.throws(()=>verify(unified,bad),/blocked/);
});

test('native Workflow drain gate fails closed for live or incomplete status inventory',()=>{
 for(const status of NONTERMINAL_NATIVE_STATUSES){
  assert.equal(verifyNativeInstanceResponse(status,{
   success:true,result:[],result_info:{count:0,total_count:0,per_page:100}}),true);
  for(const value of [
   {success:true,result:[{id:'active'}],result_info:{count:1,total_count:1}},
   {success:true,result:[],result_info:{count:0,total_count:1}},
   {success:true,result:[],result_info:{count:0}},
   {success:false,result:[],result_info:{count:0,total_count:0}},
   {success:true,result:[],result_info:{count:10,total_count:0}}
  ])assert.throws(()=>verifyNativeInstanceResponse(status,value),/blocked/);
 }
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
  ()=>requireOldIngressQuiescence(value),/quiescence/);
 assert.equal(requireOldIngressQuiescence('true'),true);
});
