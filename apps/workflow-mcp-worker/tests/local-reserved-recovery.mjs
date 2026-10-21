// Isolated local or temporary Cloudflare-edge failure injection at the public MCP seam.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
const token=process.env.S1_LOCAL_TOKEN;
if(!token)throw Error('missing local-only auth token');
const client=new Client({name:'s1-local-start-recovery-test',version:'0.1.0'});
const transport=new StreamableHTTPClientTransport(new URL((process.env.S1_LOCAL_URL??'http://127.0.0.1:8787')+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+token}}});
async function tool(name,args){
 const response=await client.callTool({name,arguments:args});
 if(response.isError)throw Error(name+' error '+JSON.stringify(response.content));
 return JSON.parse(response.content[0].text);
}
function sqlLiteral(s){return "'"+s.replaceAll("'","''")+"'";}
function executeSql(sql){
 const config=process.env.S1_EDGE_REMOTE==='1'?['--remote','--config','wrangler.s1-cloud.jsonc']:['--local','--persist-to','/tmp/workflow-s1-141-local'];
 const text=execFileSync('/usr/bin/corepack',['pnpm','exec','wrangler','d1','execute',process.env.S1_EDGE_REMOTE==='1'?'DB':'workflow-mcp-worker',...config,'--command',sql,'--json'],{encoding:'utf8',timeout:30000});
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
 // A stale uncertain start must remain the SAME Run, become transparently
 // indeterminate, and free its quota slot for fresh S1 read-only work.
 const staleId=crypto.randomUUID(), staleKey='stale-'+staleId;
 const staleAt=Date.now()-11*60*1000;
 const staleInputs='{}', staleDigest=crypto.createHash('sha256').update(staleInputs).digest('hex');
 const oldValues=[staleId,wf.workflow_id,published.published_version_id,staleId,staleKey,staleDigest,staleInputs,'start_unknown','queued'];
 const oldInsert='INSERT INTO runs(id,workflow_id,version_id,instance_id,admission_key,request_digest,inputs,start_state,outcome,created_at,updated_at) VALUES ('+
    oldValues.map(sqlLiteral).join(',')+','+staleAt+','+staleAt+')';
 const freshBlockers=Array.from({length:7},()=>crypto.randomUUID());
 const freshSql=freshBlockers.map(id=>'INSERT INTO runs(id,workflow_id,version_id,instance_id,admission_key,request_digest,inputs,start_state,outcome,created_at,updated_at) VALUES ('+
    [id,wf.workflow_id,published.published_version_id,id,'fresh-'+id,staleDigest,staleInputs,'reserved','queued'].map(sqlLiteral).join(',')+','+Date.now()+','+Date.now()+')');
 executeSql([oldInsert,...freshSql].join(';'));
 try{
    // This is intentionally the FIRST access to the stale unknown Run;
    // a new admission must reconcile it instead of permanently rejecting quota.
    const requests=[
      tool('workflow_run',{workflow_id:wf.workflow_id,inputs:{subject:'fresh allowed'},idempotency_key:'fresh-'+staleId}),
      tool('workflow_run',{workflow_id:wf.workflow_id,inputs:{subject:'fresh allowed'},idempotency_key:'fresh-'+staleId}),
      tool('workflow_status',{run_id:staleId}),
      tool('workflow_run',{workflow_id:wf.workflow_id,inputs:{},idempotency_key:staleKey})
    ];
    const [replacement,duplicateFresh,concurrentStatus,concurrentOld]=await Promise.all(requests);
    assert.ok(replacement.run_id && replacement.run_id!==staleId,'old unknown no longer holds capacity forever');
    assert.equal(duplicateFresh.run_id,replacement.run_id,'concurrent admissions with same key return one logical Run');
    assert.equal(concurrentOld.run_id,staleId,'concurrent old-key replay cannot create a replacement Run');
    assert.ok(['start_unknown','indeterminate'].includes(concurrentStatus.status),'concurrent recovery remains truthful');
    const staleStatus=await tool('workflow_status',{run_id:staleId});
    assert.equal(staleStatus.status,'indeterminate','stale unresolved Run must be reported indeterminate');
    const staleResult=await tool('workflow_result',{run_id:staleId});
    assert.equal(staleResult.error_code,'start_unconfirmed','ambiguous start error remains explicit');
    const replay=await tool('workflow_run',{workflow_id:wf.workflow_id,inputs:{},idempotency_key:staleKey});
    assert.equal(replay.run_id,staleId,'idempotent replay preserves original uncertain Run ID');
    assert.equal(replay.status,'indeterminate','replay cannot create another Workflow instance');
 }finally{
    executeSql('DELETE FROM runs WHERE id IN ('+[staleId,...freshBlockers].map(sqlLiteral).join(',')+')');
 }
 // Retention-expired native Workflow: D1 already knows the final business
 // outcome even though the original start acknowledgement was lost.
 // No Workflow instance exists for this synthetic same-ID historical Run.
 const finishedId=crypto.randomUUID(), finishedKey='completed-'+finishedId;
 const finishedAt=Date.now()-5*24*60*60*1000;
 const finishedSql='INSERT INTO runs(id,workflow_id,version_id,instance_id,admission_key,request_digest,inputs,start_state,outcome,result,created_at,updated_at) VALUES ('+
   [finishedId,wf.workflow_id,published.published_version_id,finishedId,finishedKey,crypto.createHash('sha256').update('{}').digest('hex'),'{}','start_unknown','succeeded','"retained-result"'].map(sqlLiteral).join(',')+','+finishedAt+','+finishedAt+')';
 executeSql(finishedSql);
 try{
   const observed=await tool('workflow_status',{run_id:finishedId});
   assert.equal(observed.status,'succeeded','durable D1 success survives expired native instance with ambiguous start ack');
   assert.equal(observed.start_state,'start_unknown','do not forge a recovered start acknowledgement');
   const retained=await tool('workflow_result',{run_id:finishedId});
   assert.equal(retained.status,'succeeded');
   assert.equal(retained.result,'retained-result');
   const replay=await tool('workflow_run',{workflow_id:wf.workflow_id,inputs:{},idempotency_key:finishedKey});
   assert.equal(replay.run_id,finishedId);
   assert.equal(replay.status,'succeeded','old key retains known business success and never recreates missing instance');
 }finally{executeSql('DELETE FROM runs WHERE id='+sqlLiteral(finishedId));}
 // Fault-inject an interrupted D1 terminal write after a genuinely complete
 // Workflow instance. Use the first *already finished* read-only Run.
 executeSql('UPDATE runs SET outcome=\'running\',result=NULL,native_complete_seen_at='+ (Date.now()-11*60_000) +' WHERE id='+sqlLiteral(runId));
 const stalled=await tool('workflow_status',{run_id:runId});
 assert.equal(stalled.status,'indeterminate','native complete with D1 stuck past the observation window settles to explicit uncertainty');
 const stalledResult=await tool('workflow_result',{run_id:runId});
 assert.equal(stalledResult.error_code,'outcome_unconfirmed','stalled completion has stable machine-readable error');
 console.log('S1_RESERVED_RECOVERY_PASS',JSON.stringify({run_id:runId,status:status.status,ack_recovery:true,capacity_rejected:true,stale_capacity_recovered:true}));
}finally{await client.close();}
