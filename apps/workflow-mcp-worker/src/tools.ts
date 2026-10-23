import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { workflowCapabilities } from './capabilities.ts';
import { WorkflowService, cleanError } from './store.ts';
import type { Env } from './store.ts';

const id=z.string().uuid();
const revision=z.number().int().positive();
const readonlyOperation=z.object({endpoint:z.string().url(),tool:z.string().min(1).max(128),scope:z.literal('read'),schema_digest:z.string().regex(/^[0-9a-f]{64}$/)}).strict();
const write={readOnlyHint:false,idempotentHint:false,openWorldHint:false};
const read={readOnlyHint:true,idempotentHint:true,openWorldHint:false};
// These queries may reconcile an already admitted Run, mutate D1 and resume
// its deterministic Workflow instance. Do not advertise them as read-only.
const reconcile={readOnlyHint:false,idempotentHint:true,openWorldHint:false};
export function success(body:unknown){const text=JSON.stringify(body);if(new TextEncoder().encode(text).byteLength>64*1024)return {isError:true,content:[{type:'text' as const,text:'{"error":"result_too_large"}'}]};return {content:[{type:'text' as const,text}]};}
async function safe(f:()=>Promise<unknown>){try{return success(await f());}catch(e){return {isError:true,content:[{type:'text' as const,text:JSON.stringify({error:cleanError(e)})}]};}}
export function buildMcpServer(env:Env){
 const service=new WorkflowService(env);
 const server=new McpServer({name:'workflow-mcp-worker',version:'0.1.0'},
 {capabilities:{tools:{}},instructions:'Discover supported capabilities with workflow_capabilities, draft a definition, then workflow_validate that inline definition and correct the reported issues. workflow_validate does not write, publish, authorize, or run. Create a Draft with workflow_create only after that. Publish only when the caller explicitly supplies approval: approved_operations and accept_target_risks for MCP reads, approve_heavy_execution for GitHub. Then use workflow_run, workflow_status, and workflow_result. This server does not publish or run high-impact actions by itself. Manual start is workflow_run after publish. Authenticated webhook and GitHub event triggers use that same Run admission: a stable event id dedupes to one Run, and a missing id does not promise exactly-once. Cron, HTTP, MCP writes, and shell are unsupported. Bounded repeat of result.emit is supported. foreach, while, nested steps, dynamic expansion, durable wait, child workflows, and saga are unsupported. GitHub Action claim and callback routes do not start a business Run. MCP calls stay read-only through the pinned Portal and need exact grants plus target-risk acceptance. GitHub execution needs explicit owner approval and OIDC. An allow-listed GitHub Action is discovered from workflow_capabilities with its repository, workflow file, ref, input schema, and grant. The definition cannot choose another repository, ref, workflow, or shell. Dispatch acceptance, the GitHub run id, and terminal success or failure stay separate. An ambiguous response is not dispatched again. Artifact results are metadata and URLs, not file bytes. Remote readOnlyHint is untrusted.'});
 server.registerTool('workflow_capabilities',{description:'Read supported and unsupported triggers, actions, and flow control. Omit id for the overview, or pass id for one capability, its limits, and a compiling example. Does not publish, authorize, or run.',inputSchema:z.object({id:z.string().min(1).max(128).optional()}).strict(),annotations:read},async({id})=>safe(()=>Promise.resolve(workflowCapabilities(env,id))));
 server.registerTool('workflow_list',{description:'List workflows and publication state.',inputSchema:z.object({}).strict(),annotations:read},async()=>safe(()=>service.list()));
 server.registerTool('workflow_get',{description:'Read one Draft and its active Published Version metadata.',inputSchema:z.object({workflow_id:id}).strict(),annotations:read},async({workflow_id})=>safe(()=>service.get(workflow_id)));
 server.registerTool('workflow_create',{description:'Create a Draft from YAML or JSON after workflow_validate. Does not publish or run.',inputSchema:z.object({definition:z.string().min(3).max(32768)}).strict(),annotations:write},async({definition})=>safe(()=>service.create(definition)));
 server.registerTool('workflow_update',{description:'Update an editable Draft using its expected revision. Does not publish or run.',inputSchema:z.object({workflow_id:id,expected_revision:revision,definition:z.string().min(3).max(32768)}).strict(),annotations:write},async({workflow_id,expected_revision,definition})=>safe(()=>service.update(workflow_id,expected_revision,definition)));
 server.registerTool('workflow_validate',{description:'Validate either a stored Draft (workflow_id and revision) or an inline definition, never both. Returns issues with code, path, message, and an optional suggestion. Does not write, publish, authorize, or run.',inputSchema:z.object({workflow_id:id.optional(),revision:revision.optional(),definition:z.string().min(3).max(32768).optional()}).strict(),annotations:read},async input=>safe(()=>validateCall(service,input)));
 server.registerTool('workflow_publish',{description:'Publish a validated immutable Plan only when the caller explicitly approves it. MCP calls require approved_operations and accept_target_risks=true; a GitHub Workflow CI step or allow-listed GitHub Action requires approve_heavy_execution=true. This server does not grant those approvals by itself. Grants are authenticated API assertions, not independently verified human confirmation.',inputSchema:z.object({workflow_id:id,expected_revision:revision,approved_operations:z.array(readonlyOperation).max(32).optional(),accept_target_risks:z.literal(true).optional(),approve_heavy_execution:z.literal(true).optional()}).strict(),annotations:write},async({workflow_id,expected_revision,approved_operations,accept_target_risks,approve_heavy_execution})=>safe(()=>service.publish(workflow_id,expected_revision,approved_operations,accept_target_risks,approve_heavy_execution)));
 server.registerTool('workflow_pause',{description:'Block new Run admissions without cancelling active Runs.',inputSchema:z.object({workflow_id:id}).strict(),annotations:write},async({workflow_id})=>safe(()=>service.pause(workflow_id)));
 server.registerTool('workflow_resume',{description:'Allow new Run admissions for a previously paused published Workflow.',inputSchema:z.object({workflow_id:id}).strict(),annotations:write},async({workflow_id})=>safe(()=>service.resume(workflow_id)));
 server.registerTool('workflow_run',{description:'Start a manual Run of the pinned published plan only after explicit publish. Returns a Run ID and does not wait. This server does not start high-impact actions without the published grants.',inputSchema:z.object({workflow_id:id,inputs:z.record(z.string(),z.unknown()).optional(),idempotency_key:z.string().min(1).max(128).optional()}).strict(),annotations:write},async({workflow_id,inputs,idempotency_key})=>safe(()=>service.start(workflow_id,inputs??{},idempotency_key)));
 server.registerTool('workflow_status',{description:'Inspect durable Run and Step states. A GitHub step reports dispatch_accepted, pending, external_terminal, or indeterminate, including an explicit timeout. May reconcile a previously admitted Run.',inputSchema:z.object({run_id:id}).strict(),annotations:reconcile},async({run_id})=>safe(()=>service.status(run_id)));
 server.registerTool('workflow_result',{description:'Inspect safe Run result and errors. The GitHub receipt is the external terminal result; timeout and ambiguous dispatch are indeterminate and are not dispatched again. An allow-listed action result may include artifact metadata and a scoped URL, not file bytes. May reconcile a previously admitted Run.',inputSchema:z.object({run_id:id}).strict(),annotations:reconcile},async({run_id})=>safe(()=>service.result(run_id)));
 return server;
}
function validationTargetIssue(path:string,message:string){
  return {valid:false as const,issues:[{code:'invalid_validate_target',path,message,suggestion:'Pass workflow_id with revision, or pass definition, but not both.'}]};
}
async function validateCall(service:WorkflowService,input:{workflow_id?:string;revision?:number;definition?:string}){
  const hasDefinition=input.definition!==undefined;
  const hasId=input.workflow_id!==undefined;
  const hasRevision=input.revision!==undefined;
  if(hasDefinition && (hasId||hasRevision)) return validationTargetIssue('/','Provide either workflow_id and revision or definition, not both.');
  if(hasDefinition) return service.validateDefinition(input.definition!);
  if(hasId && hasRevision) return service.validate(input.workflow_id!,input.revision!);
  if(hasId) return validationTargetIssue('/revision','revision is required when workflow_id is set.');
  if(hasRevision) return validationTargetIssue('/workflow_id','workflow_id is required when revision is set.');
  return validationTargetIssue('/','Provide workflow_id and revision, or a definition.');
}
