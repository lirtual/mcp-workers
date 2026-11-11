import {listUnifiedActions} from './action-catalog.ts';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { discoverPortalTools } from './capabilities.ts';
import {portalAuthorization} from './portal-authorization.ts';
import { WorkflowService, StateError, cleanError } from './store.ts';
import {startLitterboxUpload} from './litterbox-executor.ts';
import type { Env } from './store.ts';

const id=z.string().uuid();
const revision=z.number().int().positive();
// ChatGPT fileParams needs a top-level descriptor, not a nested Run input.
// Shape validation only; the upload path enforces the source allowlist.
const chatGptFileDescriptor=z.object({
 download_url:z.string().min(1).max(4096),
 file_id:z.string().min(1).max(512),
 mime_type:z.string().max(255).optional(),
 file_name:z.string().max(255).optional(),
}).strict();
const readonlyOperation=z.object({endpoint:z.string().url(),tool:z.string().min(1).max(128),scope:z.enum(['read','write']),schema_digest:z.string().regex(/^[0-9a-f]{64}$/)}).strict();
const approvedHttpOperation=z.object({url:z.string().url(),method:z.enum(['GET','HEAD','POST'])}).strict();
const approvedCloudflareAction=z.object({executor:z.literal('cloudflare'),
 provider:z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/),
 action:z.string().min(1).max(128).regex(/^[a-z][a-z0-9_.-]*$/),
 contract_digest:z.string().regex(/^[a-f0-9]{64}$/),deployment_id:z.string().uuid()}).strict();
const reviewedChild=z.object({workflow_id:z.string().uuid(),version_id:z.string().uuid(),digest:z.string().regex(/^[0-9a-f]{64}$/)}).strict();
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
 {capabilities:{tools:{}},instructions:'Known published workflow ID and inputs: call workflow_run, then workflow_result; use workflow_status only if not terminal. Unknown ID: workflow_list; unknown inputs: workflow_get.published_run_interface (Draft is not runnable). To author, consult the Workflow Skill or README for DSL, use workflow_action_list() for source-reviewed GitHub/Cloudflare Actions or workflow_action_list({source:"portal"}) for reviewed Portal MCP tool contracts, then workflow_validate inline before creating a Draft. Publish requires explicit human authorization for real effects and the exact target-risk grants; discovery or validation alone grants nothing. Published Plans are immutable; opt into expected_published_version_id when consistency with workflow_get matters. One-time EnvShare delivery keys cannot be recovered, Litterbox requires explicit public-upload approval, and Unknown external effects must never be blindly retried.'});
 server.registerTool('workflow_connection_status',{description:'Read current authorization and generation for portal (default) or the independent HTTP Action connection; no credentials.',inputSchema:z.object({target:z.enum(['portal','http']).optional()}).strict(),annotations:read},async({target})=>safe(()=>target==='http'?service.httpConnectionStatus():service.portalConnectionStatus()));
 server.registerTool('workflow_connection_revoke',{description:'Revoke portal (default) or http Connection. New calls are fenced atomically; existing physical effects may finish. Repeated revoke is idempotent.',inputSchema:z.object({target:z.enum(['portal','http']).optional()}).strict(),annotations:write},async({target})=>safe(()=>target==='http'?service.httpConnectionRevoke():service.portalConnectionRevoke()));
 server.registerTool('workflow_connection_enable',{description:'Re-enable portal (default) or http Connection for newly republished Plans. Previous generation stays fenced; no unknown effect replay.',inputSchema:z.object({target:z.enum(['portal','http']).optional()}).strict(),annotations:write},async({target})=>safe(()=>target==='http'?service.httpConnectionEnable():service.portalConnectionEnable()));
 server.registerTool('workflow_action_list',{description:'Without source, discover current reviewed GitHub and Cloudflare action.run candidates (unchanged contract). Use source=portal only to discover approved Portal mcp.call read/write tool contracts and schema digests; discovery never executes tools or grants permission.',inputSchema:z.object({source:z.literal('portal').optional()}).strict(),annotations:externalRead},async({source})=>safe(async()=>{
   if(source===undefined)return listUnifiedActions(env);
   const authorization=await portalAuthorization(env.DB);
   if(authorization.state==='revoked')return {source:'portal_mcp',availability:'revoked',
     read:{availability:'revoked',tools:[]},write:{availability:'revoked',tools:[]}};
   const found=await discoverPortalTools(env);
   const readTools=found.tools,writeTools=found.write_tools??[];
   const scopeStatus=(items:unknown[])=>items.length?'verified_contract':
     found.availability==='unavailable'?'unavailable':'not_authorized';
   return {source:'portal_mcp',availability:readTools.length||writeTools.length?
     'verified_contract':found.availability,
     read:{availability:scopeStatus(readTools),tools:readTools},
     write:{availability:scopeStatus(writeTools),tools:writeTools},
     ...(found.reason?{reason:found.reason}:{})};
 }));
 server.registerTool('workflow_list',{description:'List workflows, publication state, and up to four active Session quota holders (Run ID, Step ID and last recorded state). Physical health is not inferred from D1.',inputSchema:z.object({}).strict(),annotations:read},async()=>safe(()=>service.list()));
 server.registerTool('workflow_get',{description:'Read editable Draft and active immutable Published Version; published_run_interface describes only provable runtime inputs, never Draft defaults or secret literal values.',inputSchema:z.object({workflow_id:id}).strict(),annotations:read},async({workflow_id})=>safe(()=>service.get(workflow_id)));
 server.registerTool('workflow_create',{description:'Create a Draft YAML/JSON Workflow without executing it.',inputSchema:z.object({definition:z.string().min(3).max(32768)}).strict(),annotations:write},async({definition})=>safe(()=>service.create(definition)));
 server.registerTool('workflow_update',{description:'Update an editable Draft using its expected revision.',inputSchema:z.object({workflow_id:id,expected_revision:revision,definition:z.string().min(3).max(32768)}).strict(),annotations:write},async({workflow_id,expected_revision,definition})=>safe(()=>service.update(workflow_id,expected_revision,definition)));
 server.registerTool('workflow_validate',{description:'Validate either an existing Draft (workflow_id plus revision) or an inline YAML/JSON definition. Returns structured issues and required Publish approvals. Inline validation never creates a Draft, publishes, dispatches or writes D1.',inputSchema:z.object({workflow_id:id.optional(),revision:revision.optional(),definition:z.string().min(3).max(32768).optional()}).strict(),annotations:externalRead},async input=>safe(()=>validateWorkflowTarget(service,input)));
 server.registerTool('workflow_publish',{description:'Publish a validated immutable Workflow using the current trusted Action catalog. Action identities and minimum grants are derived and rechecked internally for reviewed existing effects and read-only Actions; new Cloudflare write effects require independently approved exact grants, even if a Provider manifest marks them reviewed. External MCP and HTTP targets require exact approved_operations/approved_http_operations, target-risk acceptance, and independent write/HTTP approval. Saga compensation requires separate approval. This authenticated API action never substitutes for explicit permission to affect production data, secrets or protected resources.',inputSchema:z.object({
   workflow_id:id,expected_revision:revision,
   approved_operations:z.array(readonlyOperation).max(32).optional(),
   accept_target_risks:z.literal(true).optional(),
   approved_http_operations:z.array(approvedHttpOperation).max(32).optional(),
   approve_http_execution:z.literal(true).optional(),
   approve_mcp_write_execution:z.literal(true).optional(),
   approve_saga_compensation:z.literal(true).optional(),
 }).strict(),annotations:externalWrite},async ({workflow_id,expected_revision,...options})=>
   safe(()=>service.publishReviewed(workflow_id,expected_revision,options)));
 server.registerTool('workflow_pause',{description:'Block new Run admissions without cancelling active Runs.',inputSchema:z.object({workflow_id:id}).strict(),annotations:write},async({workflow_id})=>safe(()=>service.pause(workflow_id)));
 server.registerTool('workflow_delete',{description:'Tombstone a paused or never-published Workflow at its exact Draft revision. Rejects unsettled Runs, physical Sessions and published parent references; preserves Run, Version and receipt history. Repeated deletion is idempotent.',inputSchema:z.object({workflow_id:id,expected_revision:revision}).strict(),annotations:write},async({workflow_id,expected_revision})=>safe(()=>service.delete(workflow_id,expected_revision)));
 server.registerTool('workflow_resume',{description:'Allow new Run admissions for a previously paused published Workflow.',inputSchema:z.object({workflow_id:id}).strict(),annotations:write},async({workflow_id})=>safe(()=>service.resume(workflow_id)));
 server.registerTool('workflow_run',{
   description:'Run an approved Published Workflow. Ordinary calls without a file start asynchronously and return the Run ID; EnvShare may also return a one-time delivery_key. An explicitly selected top-level file is accepted ONLY for a separately approved, manual, single-step Litterbox file Plan: inputs may contain only time (1h/12h/24h/72h), idempotency_key is mandatory, and the result reports the one-shot upload outcome. Public plaintext disclosure requires fresh Owner instruction; never retry an unknown upload. No arbitrary file URL or Provider is allowed.',
   inputSchema:z.object({
     workflow_id:id,inputs:z.record(z.string(),z.unknown()).optional(),
     idempotency_key:z.string().min(1).max(128).optional(),
     expected_published_version_id:id.optional(),
     file:chatGptFileDescriptor.optional(),
   }).strict(),
   _meta:{'openai/fileParams':['file']},
   annotations:externalWrite,
 },async({workflow_id,inputs,idempotency_key,expected_published_version_id,file})=>safe(()=>{
   if(file===undefined)return service.start(workflow_id,inputs??{},idempotency_key,undefined,false,expected_published_version_id);
   if(!idempotency_key)throw new StateError('file_idempotency_key_required');
   const selectedInputs=inputs??{};
   if(Object.keys(selectedInputs).some(k=>k!=='time')||
      (selectedInputs.time!==undefined&&typeof selectedInputs.time!=='string'))
     throw new StateError('file_inputs_invalid');
   return startLitterboxUpload(env,{workflow_id,file,
     ...(selectedInputs.time===undefined?{}:{time:selectedInputs.time as string}),
     idempotency_key,expected_published_version_id});
 }));
 server.registerTool('workflow_cancel',{description:'Request cancellation for a reviewed GitHub Action, a historical already-approved gate before its first durable GitHub Attempt, awaited child or native external event wait by Run/Step ID. A pending/approved gate or event wait must have no other active Steps; force requires an existing GitHub Attempt and cannot force-cancel an event wait. If a registered GitHub Attempt still has no confirmed physical Run identity, cancellation durably fences any later signed Claim without asserting physical termination. Once a physical Run is confirmed, existing GitHub cancellation and reconciliation govern. For children, check native Cloudflare termination but never infer external resource termination. An explicit force=true is accepted only after a prior normal cancellation and a verified still-running job has exceeded the guarded wait. Force may bypass cleanup. Repeated requests never re-POST an uncertain cancellation.',inputSchema:z.object({run_id:id,step_id:z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),force:z.literal(true).optional()}).strict(),annotations:externalWrite},async({run_id,step_id,force})=>safe(()=>service.cancel(run_id,step_id,force===true)));
 server.registerTool('workflow_status',{description:'Inspect durable Run and Step states; may reconcile a previously admitted Run.',inputSchema:z.object({run_id:id}).strict(),annotations:externalReconcile},async({run_id})=>safe(()=>service.status(run_id)));
 server.registerTool('workflow_result',{description:'Inspect safe Run result and errors; may reconcile a previously admitted Run.',inputSchema:z.object({run_id:id,delivery_key:z.string().min(1).max(40).optional()}).strict(),annotations:externalReconcile},async({run_id,delivery_key})=>safe(()=>service.result(run_id,delivery_key)));
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
