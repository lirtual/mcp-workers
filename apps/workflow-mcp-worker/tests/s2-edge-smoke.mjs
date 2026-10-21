// Optional real-Cloudflare acceptance: use only a disposable owner, D1 and read-only MCP fixture.
// Credentials and concrete endpoints are provided by the caller, never stored here.
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
const owner=process.env.S2_EDGE_OWNER_URL;
const target=process.env.S2_EDGE_TARGET_URL;
const token=process.env.S2_EDGE_ACCESS_TOKEN;
if(!owner||!target||!token)throw Error('Missing disposable S2 edge test configuration');
const makeClient=async(url,options={})=>{
  const client=new Client({name:'s2-disposable-acceptance',version:'0.1.0'});
  const transport=new StreamableHTTPClientTransport(new URL(url),options);
  await client.connect(transport);
  return client;
};
let n=0;
const check=(condition,message)=>{assert.ok(condition,message);n++;};
async function invoke(client,name,args,error){
  const response=await client.callTool({name,arguments:args});
  const first=response.content?.[0];
  assert.equal(first?.type,'text',name+' response format');
  const result=JSON.parse(first.text);
  if(error){assert.equal(response.isError,true);assert.equal(result.error,error);}
  else assert.notEqual(response.isError,true,name+' '+JSON.stringify(result));
  n++;
  return result;
}
const endpoint=new URL('/mcp',owner).href;
const unauth=await fetch(endpoint,{method:'POST',headers:{authorization:'Bearer intentionally-wrong'}});
check(unauth.status===401,'Portal rejects unauthenticated MCP');
const fixture=await makeClient(target);
let client;
try{
  const echo=(await fixture.listTools()).tools.find(t=>t.name==='echo');
  check(echo?.annotations?.readOnlyHint===true,'disposable fixture is read-only-labelled');
  client=await makeClient(endpoint,{requestInit:{headers:{authorization:'Bearer '+token}}});
  const definition={version:1,name:'Temporary trusted MCP edge smoke',steps:[
    {id:'read',uses:'mcp.call',with:{
      endpoint:target,tool:'echo',scope:'read',input_schema:echo.inputSchema,
      ...(echo.outputSchema?{output_schema:echo.outputSchema}:{}),
      arguments:{value:'edge-trusted-readonly-s2'}}},
    {id:'emit',needs:['read'],uses:'result.emit',with:{data:{ref:'steps.read.output'}}},
  ]};
  const created=await invoke(client,'workflow_create',{definition:JSON.stringify(definition)});
  const validation=await invoke(client,'workflow_validate',{workflow_id:created.workflow_id,revision:1});
  check(validation.valid===true&&validation.required_approvals?.length===1,'real edge operation preview');
  const approved=validation.required_approvals;
  const options={workflow_id:created.workflow_id,expected_revision:1};
  await invoke(client,'workflow_publish',{...options,approved_operations:approved},'target_risk_acknowledgment_required');
  await invoke(client,'workflow_publish',{...options,approved_operations:[{...approved[0],tool:'unapproved'}],accept_target_risks:true},'external_approval_required');
  const pub=await invoke(client,'workflow_publish',{...options,approved_operations:approved,accept_target_risks:true});
  check(!!pub.published_version_id,'approved immutable publication');
  const started=await invoke(client,'workflow_run',{workflow_id:created.workflow_id,inputs:{},idempotency_key:'edge-trusted-s2-once'});
  check(!!started.run_id,'actual Cloudflare Workflow started');
  let status;
  for(let i=0;i<30;i++){
    status=await invoke(client,'workflow_status',{run_id:started.run_id});
    if(['succeeded','failed','indeterminate','cancelled'].includes(status.status))break;
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  check(status?.status==='succeeded','Cloudflare Run succeeded: '+JSON.stringify(status));
  const result=await invoke(client,'workflow_result',{run_id:started.run_id});
  check(result.status==='succeeded','owner result succeeded');
  check(result.steps?.every(s=>s.status==='succeeded'),'all workflow steps completed');
  check(result.result?.content?.[0]?.text==='edge-trusted-readonly-s2','actual HTTPS MCP echo returned');
  console.log('S2_DISPOSABLE_EDGE_PASS',JSON.stringify({assertions:n,run_id:started.run_id,workflow_id:created.workflow_id}));
}finally{
  await client?.close().catch(()=>{});
  await fixture.close().catch(()=>{});
}
