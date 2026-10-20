import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { WorkflowService, cleanError } from './store.ts';
import type { Env } from './store.ts';

const id=z.string().uuid();
const revision=z.number().int().positive();
const write={readOnlyHint:false,idempotentHint:false,openWorldHint:false};
const read={readOnlyHint:true,idempotentHint:true,openWorldHint:false};
// These queries may reconcile an already admitted Run, mutate D1 and resume
// its deterministic Workflow instance. Do not advertise them as read-only.
const reconcile={readOnlyHint:false,idempotentHint:true,openWorldHint:false};
function success(body:unknown){const text=JSON.stringify(body);if(text.length>64*1024)return {isError:true,content:[{type:'text' as const,text:'{"error":"result_too_large"}'}]};return {content:[{type:'text' as const,text}]};}
async function safe(f:()=>Promise<unknown>){try{return success(await f());}catch(e){return {isError:true,content:[{type:'text' as const,text:JSON.stringify({error:cleanError(e)})}]};}}
export function buildMcpServer(env:Env){
 const service=new WorkflowService(env);
 const server=new McpServer({name:'workflow-mcp-worker',version:'0.1.0'},
 {capabilities:{tools:{}},instructions:'S1 only: manage Drafts, explicitly Publish, start asynchronous Runs and inspect safe results. Only a fixed read-only MCP test target is supported. Arbitrary network MCP calls, writes, Cron, Webhooks and heavy runners are not available.'});
 server.registerTool('workflow_list',{description:'List S1 workflows and publication state.',inputSchema:z.object({}).strict(),annotations:read},async()=>safe(()=>service.list()));
 server.registerTool('workflow_get',{description:'Read one Draft and its active Published Version metadata.',inputSchema:z.object({workflow_id:id}).strict(),annotations:read},async({workflow_id})=>safe(()=>service.get(workflow_id)));
 server.registerTool('workflow_create',{description:'Create a Draft YAML/JSON Workflow without executing it.',inputSchema:z.object({definition:z.string().min(3).max(32768)}).strict(),annotations:write},async({definition})=>safe(()=>service.create(definition)));
 server.registerTool('workflow_update',{description:'Update an editable Draft using its expected revision.',inputSchema:z.object({workflow_id:id,expected_revision:revision,definition:z.string().min(3).max(32768)}).strict(),annotations:write},async({workflow_id,expected_revision,definition})=>safe(()=>service.update(workflow_id,expected_revision,definition)));
 server.registerTool('workflow_validate',{description:'Validate the current Draft; does not publish or run.',inputSchema:z.object({workflow_id:id,revision}).strict(),annotations:read},async({workflow_id,revision})=>safe(()=>service.validate(workflow_id,revision)));
 server.registerTool('workflow_publish',{description:'Atomically publish a compiled immutable Plan from the expected Draft revision.',inputSchema:z.object({workflow_id:id,expected_revision:revision}).strict(),annotations:write},async({workflow_id,expected_revision})=>safe(()=>service.publish(workflow_id,expected_revision)));
 server.registerTool('workflow_pause',{description:'Block new Run admissions without cancelling active Runs.',inputSchema:z.object({workflow_id:id}).strict(),annotations:write},async({workflow_id})=>safe(()=>service.pause(workflow_id)));
 server.registerTool('workflow_resume',{description:'Allow new Run admissions for a previously paused published Workflow.',inputSchema:z.object({workflow_id:id}).strict(),annotations:write},async({workflow_id})=>safe(()=>service.resume(workflow_id)));
 server.registerTool('workflow_run',{description:'Asynchronously start a manual S1 Run. Returns Run ID; never waits for execution.',inputSchema:z.object({workflow_id:id,inputs:z.record(z.string(),z.unknown()).optional(),idempotency_key:z.string().min(1).max(128).optional()}).strict(),annotations:write},async({workflow_id,inputs,idempotency_key})=>safe(()=>service.start(workflow_id,inputs??{},idempotency_key)));
 server.registerTool('workflow_status',{description:'Inspect durable Run and Step states; may reconcile a previously admitted Run.',inputSchema:z.object({run_id:id}).strict(),annotations:reconcile},async({run_id})=>safe(()=>service.status(run_id)));
 server.registerTool('workflow_result',{description:'Inspect safe Run result and errors; may reconcile a previously admitted Run.',inputSchema:z.object({run_id:id}).strict(),annotations:reconcile},async({run_id})=>safe(()=>service.result(run_id)));
 return server;
}
