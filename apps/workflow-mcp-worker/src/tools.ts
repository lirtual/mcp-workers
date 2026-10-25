import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { listAvailableGitHubActions } from './github-action-catalog.ts';
import { workflowCapabilities } from './capabilities.ts';
import { WorkflowService, cleanError } from './store.ts';
import type { Env } from './store.ts';

const id=z.string().uuid();
const revision=z.number().int().positive();
const readonlyOperation=z.object({endpoint:z.string().url(),tool:z.string().min(1).max(128),scope:z.literal('read'),schema_digest:z.string().regex(/^[0-9a-f]{64}$/)}).strict();
const reviewedAction=z.object({repository:z.string(),repositoryId:z.number().int().positive(),workflowId:z.number().int().positive(),workflowPath:z.string(),commitSha:z.string().regex(/^[a-f0-9]{40}$/i),type:z.enum(['task','session']),contractDigest:z.string().regex(/^[a-f0-9]{64}$/i)}).strict();
const write={readOnlyHint:false,idempotentHint:false,openWorldHint:false};
const read={readOnlyHint:true,idempotentHint:true,openWorldHint:false};
// These queries may reconcile an already admitted Run, mutate D1 and resume
// its deterministic Workflow instance. Do not advertise them as read-only.
const reconcile={readOnlyHint:false,idempotentHint:true,openWorldHint:false};
// GitHub discovery, validation, publication, start, status and cancellation
// cross the external GitHub API boundary; don't mark them closed-world.
const externalRead={...read,openWorldHint:true};
const externalWrite={...write,openWorldHint:true};
const externalReconcile={...reconcile,openWorldHint:true};
export function success(body:unknown){const text=JSON.stringify(body);if(new TextEncoder().encode(text).byteLength>64*1024)return {isError:true,content:[{type:'text' as const,text:'{"error":"result_too_large"}'}]};return {content:[{type:'text' as const,text}]};}
async function safe(f:()=>Promise<unknown>){try{return success(await f());}catch(e){return {isError:true,content:[{type:'text' as const,text:JSON.stringify({error:cleanError(e)})}]};}}
export function buildMcpServer(env:Env){
 const service=new WorkflowService(env);
 const server=new McpServer({name:'workflow-mcp-worker',version:'0.1.0'},
 {capabilities:{tools:{}},instructions:'First use workflow_capabilities to discover supported Triggers, Action schemas, and live reviewed Portal tool contracts; use workflow_action_list for Tag-verified GitHub Action candidates. Treat configured/unverified and unpublished revisions as unavailable for execution. Construct a Draft definition and use workflow_validate with inline definition before workflow_create. Inline validation never creates, publishes or runs anything. Workflows use immutable published plans. MCP calls through the pinned Portal require exact read-scope/schema grants and explicit target-risk acceptance. Reviewed GitHub Task/Session Actions require explicit repository/revision approval, signed physical GitHub OIDC identity, and durable lifecycle tracking. Approved GitHub Actions may have external side effects; discovery alone never authorizes execution. Arbitrary commands and GitHub business event triggers are not supported. Cron uses published UTC schedules; Webhook uses independent per-Workflow bearer authentication. GitHub push relay uses a GitHub-signed OIDC job identity bound to the Published Plan (not a native GitHub webhook). All triggers share immutable admission/grant gates.'});
 server.registerTool('workflow_capabilities',{description:'Read compiler-aligned Trigger/Action/Flow schemas, expression rules and examples; id=action.mcp.call discovers actual source-reviewed Portal read tools, id=action.github.run lists Tag-verified candidates. Configured is not verified; discovery is not an execution grant.',inputSchema:z.object({id:z.string().min(1).max(128).optional()}).strict(),annotations:externalRead},async({id})=>safe(()=>workflowCapabilities(env,id)));
 server.registerTool('workflow_action_list',{description:'Discover verified Tag-pinned GitHub Task/Session Action candidates with ref, commitSha, contractDigest, inputs and publishability. Untagged default-branch revisions are explicitly unavailable; Publish still requires separate approval.',inputSchema:z.object({}).strict(),annotations:externalRead},async()=>safe(()=>listAvailableGitHubActions(env)));
 server.registerTool('workflow_list',{description:'List workflows, publication state, and up to four active Session quota holders (Run ID, Step ID and last recorded state). Physical health is not inferred from D1.',inputSchema:z.object({}).strict(),annotations:read},async()=>safe(()=>service.list()));
 server.registerTool('workflow_get',{description:'Read one Draft and its active Published Version metadata.',inputSchema:z.object({workflow_id:id}).strict(),annotations:read},async({workflow_id})=>safe(()=>service.get(workflow_id)));
 server.registerTool('workflow_create',{description:'Create a Draft YAML/JSON Workflow without executing it.',inputSchema:z.object({definition:z.string().min(3).max(32768)}).strict(),annotations:write},async({definition})=>safe(()=>service.create(definition)));
 server.registerTool('workflow_update',{description:'Update an editable Draft using its expected revision.',inputSchema:z.object({workflow_id:id,expected_revision:revision,definition:z.string().min(3).max(32768)}).strict(),annotations:write},async({workflow_id,expected_revision,definition})=>safe(()=>service.update(workflow_id,expected_revision,definition)));
 server.registerTool('workflow_validate',{description:'Validate either an existing Draft (workflow_id plus revision) or an inline YAML/JSON definition. Returns structured issues and required Publish approvals. Inline validation never creates a Draft, publishes, dispatches or writes D1.',inputSchema:z.object({workflow_id:id.optional(),revision:revision.optional(),definition:z.string().min(3).max(32768).optional()}).strict(),annotations:externalRead},async input=>safe(()=>validateWorkflowTarget(service,input)));
 server.registerTool('workflow_publish',{description:'Publish a validated immutable Plan. MCP calls require approved_operations and accept_target_risks=true; GitHub execution requires approve_heavy_execution=true, and Task/Session Actions also require exact approved_actions grants. Grants are authenticated API assertions, not independently verified human confirmation.',inputSchema:z.object({workflow_id:id,expected_revision:revision,approved_operations:z.array(readonlyOperation).max(32).optional(),accept_target_risks:z.literal(true).optional(),approve_heavy_execution:z.literal(true).optional(),approved_actions:z.array(reviewedAction).max(32).optional()}).strict(),annotations:externalWrite},async({workflow_id,expected_revision,approved_operations,accept_target_risks,approve_heavy_execution,approved_actions})=>safe(()=>service.publish(workflow_id,expected_revision,approved_operations,accept_target_risks,approve_heavy_execution,approved_actions)));
 server.registerTool('workflow_pause',{description:'Block new Run admissions without cancelling active Runs.',inputSchema:z.object({workflow_id:id}).strict(),annotations:write},async({workflow_id})=>safe(()=>service.pause(workflow_id)));
 server.registerTool('workflow_resume',{description:'Allow new Run admissions for a previously paused published Workflow.',inputSchema:z.object({workflow_id:id}).strict(),annotations:write},async({workflow_id})=>safe(()=>service.resume(workflow_id)));
 server.registerTool('workflow_run',{description:'Asynchronously start a manual Run of the pinned published plan (Cron admission is automatic for active published UTC schedules). Returns Run ID; never waits for execution.',inputSchema:z.object({workflow_id:id,inputs:z.record(z.string(),z.unknown()).optional(),idempotency_key:z.string().min(1).max(128).optional()}).strict(),annotations:externalWrite},async({workflow_id,inputs,idempotency_key})=>safe(()=>service.start(workflow_id,inputs??{},idempotency_key)));
 server.registerTool('workflow_cancel',{description:'Request cancellation for one published GitHub Action Step by Workflow Run/Step ID; never treat GitHub 202 as physical terminal. An explicit force=true is accepted only after a prior normal cancellation and a verified still-running job has exceeded the guarded wait. Force may bypass cleanup. Repeated requests never re-POST an uncertain cancellation.',inputSchema:z.object({run_id:id,step_id:z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),force:z.literal(true).optional()}).strict(),annotations:externalWrite},async({run_id,step_id,force})=>safe(()=>service.cancel(run_id,step_id,force===true)));
 server.registerTool('workflow_status',{description:'Inspect durable Run and Step states; may reconcile a previously admitted Run.',inputSchema:z.object({run_id:id}).strict(),annotations:externalReconcile},async({run_id})=>safe(()=>service.status(run_id)));
 server.registerTool('workflow_result',{description:'Inspect safe Run result and errors; may reconcile a previously admitted Run.',inputSchema:z.object({run_id:id}).strict(),annotations:externalReconcile},async({run_id})=>safe(()=>service.result(run_id)));
 return server;
}

/** Reject ambiguous validation targets without touching a Draft or D1. */
export async function validateWorkflowTarget(
 service:Pick<WorkflowService,'validate'|'validateDefinition'>,
 input:{workflow_id?:string;revision?:number;definition?:string},
){
 const hasId=input.workflow_id!==undefined;
 const hasRevision=input.revision!==undefined;
 const hasDefinition=input.definition!==undefined;
 const invalid=(path:string,message:string)=>({
   valid:false as const,issues:[{
     code:'invalid_validate_target',path,message,
     suggestion:'Provide either workflow_id with revision, or definition, never both.',
   }],
 });
 if(hasDefinition && (hasId||hasRevision))
   return invalid('/','Inline definition cannot be combined with a Draft ID or revision.');
 if(hasDefinition) return service.validateDefinition(input.definition!);
 if(hasId && hasRevision) return service.validate(input.workflow_id!,input.revision!);
 if(hasId) return invalid('/revision','revision is required with workflow_id.');
 if(hasRevision) return invalid('/workflow_id','workflow_id is required with revision.');
 return invalid('/','Provide a Draft ID and revision, or an inline definition.');
}
