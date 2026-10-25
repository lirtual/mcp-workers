import {compilePlan, PLAN_LIMITS, SUPPORTED_STEP_USES} from './plan.ts';
import {PRODUCTION_PORTAL_ENDPOINT} from './mcp-public-fetch.ts';
import {listAvailableGitHubActions,approvedActionRepositories} from './github-action-catalog.ts';
import type {Env} from './store.ts';

// The compiler is the authority: no secondary validator, remote marketplace,
// standalone registry, or persisted capability catalogue.
const emit = {version:1,name:'Emit an input',inputs:{message:'hello'},
  steps:[{id:'out',uses:'result.emit',with:{data:{ref:'inputs.message'}}}]};
const dag = {version:1,name:'Conditional DAG',steps:[
  {id:'first',uses:'result.emit',with:{data:'ok'}},
  {id:'second',needs:['first'],uses:'result.emit',
    if:{eq:[{ref:'steps.first.status'},'succeeded']},
    with:{data:{ref:'steps.first.output'}}},
]};
const mcpRead = {version:1,name:'Portal read example',inputs:{query:'example'},
  steps:[{id:'read',uses:'mcp.call',with:{
    endpoint:PRODUCTION_PORTAL_ENDPOINT,tool:'reviewed_read_tool',scope:'read',
    input_schema:{type:'object',properties:{query:{type:'string'}}},
    arguments:{query:{ref:'inputs.query'}},
  }}]};

export const WORKFLOW_DEFINITION_SCHEMA = Object.freeze({
  type:'object',additionalProperties:false,
  required:['version','name','steps'],
  properties:{
    version:{const:1},
    name:{type:'string',minLength:1,maxLength:120},
    inputs:{type:'object',maxProperties:PLAN_LIMITS.maxInputs},
    steps:{type:'array',minItems:1,maxItems:PLAN_LIMITS.maxSteps,items:{
      type:'object',additionalProperties:false,
      required:['id','uses','with'],
      properties:{
        id:{type:'string',pattern:'^[A-Za-z][A-Za-z0-9_-]{0,63}$'},
        uses:{enum:[...SUPPORTED_STEP_USES]},
        needs:{type:'array',items:{type:'string'}},
        if:{description:'Bounded safe expression; consult workflow_validate for semantics'},
        with:{type:'object',description:'Action-specific contract; consult workflow_capabilities detail and workflow_validate'},
      },
    }},
  },
});

const entries=[
  {id:'trigger.manual',kind:'trigger',availability:'supported',
   description:'Manually admit the current Published Version with workflow_run; supply idempotency_key to deduplicate.'},
  {id:'trigger.cron',kind:'trigger',availability:'unsupported',
   description:'The current compiler rejects triggers. No Cron ingress or timezone/DST promise.'},
  {id:'trigger.webhook',kind:'trigger',availability:'unsupported',
   description:'No owner-facing business Webhook ingress. GitHub signed Action callbacks are not business Triggers.'},
  {id:'trigger.github_event',kind:'trigger',availability:'unsupported',
   description:'GitHub lifecycle callbacks are execution receipts, not user-defined business events.'},
  {id:'action.result.emit',kind:'action',availability:'supported',
   description:'Emit a bounded deterministic result; with={data:expression}.'},
  {id:'action.mcp.call',kind:'action',availability:'supported_with_grant',
   description:'Call only reviewed read-scope tools on the pinned MCP Portal. Exact tool/schema grant and risk acceptance are mandatory.'},
  {id:'action.github.run',kind:'action',availability:'supported_with_grant',
   description:'Dispatch reviewed github.action Task/Session. Discover allowed repositories with workflow_action_list, then pin exact immutable commit, approved ref, contract digest and inputs.'},
  {id:'flow.static_dag',kind:'flow',availability:'supported',
   description:'Acyclic needs dependencies, bounded steps and parallel admission. Steps run under one Cloudflare Workflow instance.'},
  {id:'flow.condition',kind:'flow',availability:'supported',
   description:'Step if accepts safe ref/eq/ne/gt/lt/and/or/not expressions with compiler validation.'},
  {id:'flow.loop',kind:'flow',availability:'unsupported',
   description:'Repeat, while, foreach, nested steps and dynamic expansion are not executable in the current compiler.'},
  {id:'flow.child',kind:'flow',availability:'unsupported',
   description:'Child workflows and durable wait are not supported in the current Published Plan schema.'},
  {id:'flow.saga',kind:'flow',availability:'unsupported',
   description:'No compensating transaction semantics are provided; cancel does not promise rollback.'},
] as const;
type Entry=typeof entries[number];
const byId=new Map<string,Entry>(entries.map(entry=>[entry.id,entry]));

async function compilingExample(definition:unknown){
  // Each published sample is checked against the exact active compiler.
  // This is compile-only: tool availability and Publish authorization are
  // separate gates, especially for the illustrative MCP tool identifier.
  const {digest}=await compilePlan(definition);
  return {definition,digest,validation:'compiler_valid_only' as const};
}

export async function workflowCapabilities(env:Pick<Env,
 'MCP_PORTAL_ENDPOINT'|'MCP_PORTAL_CLIENT_ID'|'MCP_PORTAL_CLIENT_SECRET'|
 'GITHUB_ACTION_APPROVED_REPOSITORIES'|'WORKFLOW_GITHUB_DISPATCH_TOKEN'>,id?:string){
  const portalReady=env.MCP_PORTAL_ENDPOINT===PRODUCTION_PORTAL_ENDPOINT &&
    !!env.MCP_PORTAL_CLIENT_ID && !!env.MCP_PORTAL_CLIENT_SECRET;
  let githubReady=false;
  try {
    githubReady=approvedActionRepositories(env.GITHUB_ACTION_APPROVED_REPOSITORIES).length>0 &&
      !!env.WORKFLOW_GITHUB_DISPATCH_TOKEN;
  }catch { githubReady=false; } // invalid scope is never treated as approved
  const availability=(entry:Entry)=>
    entry.id==='action.mcp.call'&&!portalReady?'unavailable':
    entry.id==='action.github.run'&&!githubReady?'unavailable':entry.availability;
  if(id===undefined)return {
    definition_schema:WORKFLOW_DEFINITION_SCHEMA,
    limits:PLAN_LIMITS,
    capability_ids:entries.map(entry=>({
      id:entry.id,kind:entry.kind,availability:availability(entry),description:entry.description,
    })),
    connections:portalReady?{portal:{endpoint:PRODUCTION_PORTAL_ENDPOINT,scope:'read'}}:{portal:{availability:'unavailable'}},
    github_repository_scope:githubReady?'configured':'unavailable',
    tools:{discover_actions:'workflow_action_list',validate:'workflow_validate',
      create:'workflow_create',publish:'workflow_publish',start:'workflow_run',
      status:'workflow_status',result:'workflow_result'},
    admission:'Manual start only; no Cron/Webhook/GitHub business event ingress',
    note:'Discovery and inline validation never publish or grant execution.',
  };
  const entry=byId.get(id);
  if(!entry)return {id,availability:'unknown',reason:'unknown_capability'};
  const detail:Record<string,unknown>={...entry,availability:availability(entry),limits:PLAN_LIMITS};
  if(id==='action.result.emit'||id==='trigger.manual')
    detail.example=await compilingExample(emit);
  if(id==='flow.static_dag'||id==='flow.condition')
    detail.example=await compilingExample(dag);
  if(id==='action.mcp.call'){
    if(portalReady)detail.example=await compilingExample(mcpRead);
    detail.grant={scope:'read',...(portalReady?{pinnedEndpoint:PRODUCTION_PORTAL_ENDPOINT}:{}),
      required:['approved_operations','accept_target_risks'],
      warning:'The example tool is illustrative; availability and exact schema must be reviewed before Publish.'};
  }
  if(id==='action.github.run'){
    const approved=githubReady?await listAvailableGitHubActions(env):{actions:[]};
    detail.discovered_actions=approved.actions;
    detail.grant={required:['approved_actions','approve_heavy_execution'],
      note:'Discovery is not approval; review exact SHA, immutable tag/ref, workflow and contract digest before Publish.'};
  }
  return detail;
}
