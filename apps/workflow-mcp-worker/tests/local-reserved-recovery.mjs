// Local-only failure injection at the public MCP seam and isolated local D1.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
const token=process.env.S1_LOCAL_TOKEN;
if(!token)throw Error('missing local-only auth token');
const client=new Client({name:'s1-local-start-recovery-test',version:'0.1.0'});
const transport=new StreamableHTTPClientTransport(new URL('http://127.0.0.1:8787/mcp'),{requestInit:{headers:{authorization:'Bearer '+token}}});
async function tool(name,args){
 const response=await client.callTool({name,arguments:args});
 if(response.isError)throw Error(name+' error '+JSON.stringify(response.content));
 return JSON.parse(response.content[0].text);
}
function sqlLiteral(s){return "'"+s.replaceAll("'","''")+"'";}
function executeSql(sql){
 const text=execFileSync('/usr/bin/corepack',['pnpm','exec','wrangler','d1','execute','workflow-mcp-worker','--local','--persist-to','/tmp/workflow-s1-141-local','--command',sql,'--json'],{encoding:'utf8',timeout:15000});
 const result=JSON.parse(text);
 assert.equal(result[0]?.success,true);
}
try{
 await client.connect(transport);
 const def={version:1,name:'S1 reserved fault',steps:[{id:'emit',uses:'result.emit',with:{data:{ref:'inputs.subject'}}}]};
 const wf=await tool('workflow_create',{definition:JSON.stringify(def)});
 const published=await tool('workflow_publish',{workflow_id:wf.workflow_id,expected_revision:1});
 const runId=crypto.randomUUID(), now=Date.now(), args=JSON.stringify({subject:'recovered reserved run'});
 const sql="INSERT INTO runs(id,workflow_id,version_id,instance_id,admission_key,request_digest,inputs,start_state,outcome,created_at,updated_at) VALUES ("+
 [runId,wf.workflow_id,published.published_version_id,runId,'reserved-fault-'+runId,'manual-injected',args,'reserved','queued'].map(sqlLiteral).join(',')+
 ","+now+","+now+")";
 executeSql(sql);
 let status=await tool('workflow_status',{run_id:runId});
 assert.equal(status.start_state,'started','reserved D1 Run must recover creation with same instance ID');
 for(let i=0;i<20 && status.status!=='succeeded';i++){
   await new Promise(r=>setTimeout(r,300));
   status=await tool('workflow_status',{run_id:runId});
 }
 assert.equal(status.status,'succeeded','resumed Workflow executes pinned read-only result');
 const result=await tool('workflow_result',{run_id:runId});
 assert.equal(result.result,'recovered reserved run');
 // Simulate the ack being lost after a Workflow instance was created.
 executeSql('UPDATE runs SET start_state=\'start_unknown\' WHERE id='+sqlLiteral(runId));
 const recovered=await tool('workflow_status',{run_id:runId});
 assert.equal(recovered.start_state,'started','existing instance reconciles without a duplicate');
 // Saturate application capacity in isolated D1; verify the public MCP contract.
 const blockers=Array.from({length:8},()=>crypto.randomUUID());
 const inserts=blockers.map(id=>'INSERT INTO runs(id,workflow_id,version_id,instance_id,admission_key,request_digest,inputs,start_state,outcome,created_at,updated_at) VALUES ('+
  [id,wf.workflow_id,published.published_version_id,id,'fault-'+id,'manual-injected','{}','reserved','queued'].map(sqlLiteral).join(',')+','+now+','+now+')');
 executeSql(inserts.join(';'));
 try {
   const rejected=await client.callTool({name:'workflow_run',arguments:{workflow_id:wf.workflow_id,inputs:{subject:'should not run'},idempotency_key:'capacity-'+runId}});
   assert.equal(rejected.isError,true,'capacity limit must reject admission');
   assert.equal(JSON.parse(rejected.content[0].text).error,'run_capacity_exceeded');
 }finally{
   executeSql('DELETE FROM runs WHERE id IN ('+blockers.map(sqlLiteral).join(',')+')');
 }
 console.log('S1_RESERVED_RECOVERY_PASS',JSON.stringify({run_id:runId,status:status.status,ack_recovery:true,capacity_rejected:true}));
}finally{await client.close();}
