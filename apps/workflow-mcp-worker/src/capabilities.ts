import {compilePlan, PLAN_LIMITS, SUPPORTED_STEP_USES} from './plan.ts';
import {PRODUCTION_PORTAL_ENDPOINT,scopedPublicMcpFetch} from './mcp-public-fetch.ts';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {toolSchemaDigest} from './plan.ts';
import {listAvailableGitHubActions,approvedActionRepositories} from './github-action-catalog.ts';
import type {Env} from './store.ts';

type PortalConfig=Pick<Env,'MCP_PORTAL_ENDPOINT'|'MCP_PORTAL_CLIENT_ID'|'MCP_PORTAL_CLIENT_SECRET'>;
type PortalTool={
 name:string;inputSchema:unknown;outputSchema?:unknown;
 annotations?:{readOnlyHint?:boolean;destructiveHint?:boolean};
};
type PortalToolContract={
 tool:string;endpoint:string;scope:'read';input_schema:unknown;
 output_schema?:unknown;schema_digest:string;arguments:{limit:number};
 availability:'discovered_not_executed';
};
type PortalDiscovery={availability:'verified_contract'|'unavailable'|'not_authorized';
 tools:PortalToolContract[];reason?:string};

/**
 * Explicitly source-reviewed operations only. An upstream readOnlyHint does
 * not grant safety or authority. This is deliberately NOT a generic filter for
 * every readOnlyHint in the Portal's mixed read/write catalog.
 */
export async function reviewedPortalTools(tools:PortalTool[]):Promise<PortalToolContract[]>{
 // Duplicate tool identities in a multiplexed Portal are ambiguous; never
 // silently select the first matching upstream or trust its annotations.
 if(tools.filter(t=>t.name==='ima_list_notebooks').length!==1)return [];
 const found:PortalToolContract[]=[];
 for(const tool of tools){
   if(tool.name!=='ima_list_notebooks'||tool.annotations?.readOnlyHint!==true||
      tool.annotations.destructiveHint===true)continue;
   const input=tool.inputSchema as {type?:unknown;properties?:unknown;required?:unknown};
   if(!input||input.type!=='object'||!input.properties||
      typeof input.properties!=='object'||Array.isArray(input.properties))continue;
   const props=input.properties as Record<string,unknown>;
   if(Object.keys(props).some(k=>!['cursor','limit'].includes(k)) ||
      (input.required!==undefined&&
       (!Array.isArray(input.required)||input.required.length>0)))continue;
   const cursor=props.cursor as {type?:unknown}|undefined;
   const limit=props.limit as {type?:unknown}|undefined;
   if((cursor&&cursor.type!=='string')||
      (limit&&limit.type!=='number'&&limit.type!=='integer')||
      !limit)continue;
   try{
     const schema_digest=await toolSchemaDigest(tool.inputSchema,tool.outputSchema);
     found.push({tool:tool.name,endpoint:PRODUCTION_PORTAL_ENDPOINT,scope:'read',
       input_schema:tool.inputSchema,
       ...(tool.outputSchema?{output_schema:tool.outputSchema}:{}),
       schema_digest,arguments:{limit:1},availability:'discovered_not_executed'});
   }catch{ /* The existing compiler's bounded schema gate is authoritative. */ }
 }
 return found;
}

/** Read the actual restricted Portal catalog with the same credential/URL
 * boundary as runtime. Never call a tool during discovery, never leak errors.
 */
export async function discoverPortalTools(env:PortalConfig):Promise<PortalDiscovery>{
 if(env.MCP_PORTAL_ENDPOINT!==PRODUCTION_PORTAL_ENDPOINT ||
    !env.MCP_PORTAL_CLIENT_ID||!env.MCP_PORTAL_CLIENT_SECRET)
   return {availability:'unavailable',tools:[],reason:'portal_not_configured'};
 const client=new Client({name:'workflow-mcp-action-discovery',version:'0.1.0'});
 let authDenied=false;
 const trackedFetch:typeof fetch=async(input,init)=>{
   const result=await fetch(input,init);
   if([401,403].includes(result.status)||result.status>=300&&result.status<400)
     authDenied=true;
   return result;
 };
 const transport=new StreamableHTTPClientTransport(new URL(PRODUCTION_PORTAL_ENDPOINT),{
   fetch:scopedPublicMcpFetch(PRODUCTION_PORTAL_ENDPOINT,trackedFetch,{
     clientId:env.MCP_PORTAL_CLIENT_ID,clientSecret:env.MCP_PORTAL_CLIENT_SECRET,
   },PRODUCTION_PORTAL_ENDPOINT),
 });
 try{
   await client.connect(transport);
   const result=await client.listTools();
   const contracts=await reviewedPortalTools(result.tools);
   return {availability:contracts.length?'verified_contract':'not_authorized',
     tools:contracts,...(!contracts.length?{reason:'approved_read_tool_not_present_or_schema_changed'}:{})};
 }catch{
   return {availability:authDenied?'not_authorized':'unavailable',
     tools:[],reason:authDenied?'portal_access_denied':'portal_unreachable'};
 }finally{
   await client.close().catch(()=>{});
 }
}

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
const mcpRead=(tool:PortalToolContract)=>({version:1,name:'Verified Portal contract example',
  steps:[{id:'read',uses:'mcp.call',with:{
    endpoint:tool.endpoint,tool:tool.tool,scope:'read',
    input_schema:tool.input_schema,
    ...(tool.output_schema?{output_schema:tool.output_schema}:{}),
    arguments:tool.arguments,
  }}]});

export const WORKFLOW_ACTION_WITH_SCHEMAS=Object.freeze({
  'result.emit':{type:'object',additionalProperties:false,
    properties:{data:{description:'Bounded literal or safe expression; omitted data emits null at runtime.'}}},
  'mcp.call':{type:'object',additionalProperties:false,
    required:['endpoint','tool','scope','arguments','input_schema'],
    properties:{
      endpoint:{const:PRODUCTION_PORTAL_ENDPOINT},
      tool:{type:'string',pattern:'^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,127}$'},
      scope:{const:'read'},arguments:{type:'object'},
      input_schema:{type:'object'},output_schema:{type:'object'},
    }},
  'github.run':{type:'object',additionalProperties:false,
    required:['capability','action'],properties:{
      capability:{const:'github.action'},
      action:{type:'object',additionalProperties:false,
        required:['repository','repositoryId','workflowId','workflowPath',
          'commitSha','type','contractDigest','ref','inputs'],
        properties:{
          repository:{type:'string'},repositoryId:{type:'integer',minimum:1},
          workflowId:{type:'integer',minimum:1},
          workflowPath:{type:'string',pattern:'^\\.github/workflows/.+\\.ya?ml$'},
          commitSha:{type:'string',pattern:'^[a-fA-F0-9]{40}$'},
          type:{enum:['task','session']},
          contractDigest:{type:'string',pattern:'^[a-fA-F0-9]{64}$'},
          ref:{type:'string',pattern:'^refs/tags/[A-Za-z0-9]'},
          inputs:{type:'object'},
        }},
    }},
});
export const WORKFLOW_EXPRESSION_RULES=Object.freeze({
  refs:['inputs.<name>','steps.<declared-needs-id>.status',
    'steps.<declared-needs-id>.output[.<field>]'],
  operators:['ref','eq','ne','gt','lt','and','or','not'],
  condition:'Boolean literal or safe expression that evaluates to Boolean; eq/ne/gt/lt take 2 operands, and/or take 1-16 operands.',
  needs:'Only existing Step IDs, no duplicates or cycles; reference another Step only if it appears in needs.',
  limits:{maxDepth:15,maxArrayElements:100,maxBooleanOperands:16},
  unsupported:['foreach','while','repeat','child_workflow','saga','cron','webhook'],
});

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
        needs:{type:'array',uniqueItems:true,items:{type:'string'}},
        if:{anyOf:[{type:'boolean'},{type:'object'}],description:'Safe Boolean condition; see expression_rules and inline validation.'},
        with:{type:'object',description:'Must match the matching uses/action contract below.'},
      },
      allOf:[
        {if:{properties:{uses:{const:'result.emit'}}},then:{properties:{with:WORKFLOW_ACTION_WITH_SCHEMAS['result.emit']}}},
        {if:{properties:{uses:{const:'mcp.call'}}},then:{properties:{with:WORKFLOW_ACTION_WITH_SCHEMAS['mcp.call']}}},
        {if:{properties:{uses:{const:'github.run'}}},then:{properties:{with:WORKFLOW_ACTION_WITH_SCHEMAS['github.run']}}},
      ],
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
 'GITHUB_ACTION_APPROVED_REPOSITORIES'|'WORKFLOW_GITHUB_DISPATCH_TOKEN'>,
 id?:string,portalDiscovery:typeof discoverPortalTools=discoverPortalTools){
  const portalReady=env.MCP_PORTAL_ENDPOINT===PRODUCTION_PORTAL_ENDPOINT &&
    !!env.MCP_PORTAL_CLIENT_ID && !!env.MCP_PORTAL_CLIENT_SECRET;
  let githubReady=false;
  try {
    githubReady=approvedActionRepositories(env.GITHUB_ACTION_APPROVED_REPOSITORIES).length>0 &&
      !!env.WORKFLOW_GITHUB_DISPATCH_TOKEN;
  }catch { githubReady=false; } // invalid scope is never treated as approved
  const availability=(entry:Entry)=>
    entry.id==='action.mcp.call'&&!portalReady?'unavailable':
    entry.id==='action.github.run'&&!githubReady?'unavailable':
    ['action.mcp.call','action.github.run'].includes(entry.id)?'configured_unverified':entry.availability;
  if(id===undefined)return {
    definition_schema:WORKFLOW_DEFINITION_SCHEMA,
    action_with_schemas:WORKFLOW_ACTION_WITH_SCHEMAS,
    expression_rules:WORKFLOW_EXPRESSION_RULES,
    limits:PLAN_LIMITS,
    capability_ids:entries.map(entry=>({
      id:entry.id,kind:entry.kind,availability:availability(entry),description:entry.description,
    })),
    connections:portalReady?{portal:{endpoint:PRODUCTION_PORTAL_ENDPOINT,scope:'read',availability:'configured_unverified'}}:{portal:{availability:'unavailable'}},
    availability_note:'Configured means credentials exist, not verified access or publication permission.',
    github_repository_scope:githubReady?'configured':'unavailable',
    tools:{discover_actions:'workflow_action_list',validate:'workflow_validate',
      create:'workflow_create',publish:'workflow_publish',start:'workflow_run',
      status:'workflow_status',result:'workflow_result'},
    admission:'Manual start only; no Cron/Webhook/GitHub business event ingress',
    note:'Discovery and inline validation never publish or grant execution.',
  };
  const entry=byId.get(id);
  if(!entry)return {id,availability:'unknown',reason:'unknown_capability'};
  const detail:Record<string,unknown>={...entry,availability:availability(entry),limits:PLAN_LIMITS,
    ...(id==='flow.condition'?{expression_rules:WORKFLOW_EXPRESSION_RULES}:{}),
    ...(id==='action.result.emit'?{with_schema:WORKFLOW_ACTION_WITH_SCHEMAS['result.emit']}:{}),
    ...(id==='action.mcp.call'?{with_schema:WORKFLOW_ACTION_WITH_SCHEMAS['mcp.call']}:{}),
    ...(id==='action.github.run'?{with_schema:WORKFLOW_ACTION_WITH_SCHEMAS['github.run']}:{}),
  };
  if(id==='action.result.emit'||id==='trigger.manual')
    detail.example=await compilingExample(emit);
  if(id==='flow.static_dag'||id==='flow.condition')
    detail.example=await compilingExample(dag);
  if(id==='action.mcp.call'){
    const discovered=await portalDiscovery(env);
    detail.availability=discovered.availability;
    detail.discovered_tools=discovered.tools;
    if(discovered.reason)detail.reason=discovered.reason;
    if(discovered.tools.length){
      detail.example=await compilingExample(mcpRead(discovered.tools[0]));
      detail.example_validation='compiler_valid_and_live_contract_discovered; tools/call not performed';
    }
    detail.grant={scope:'read',...(portalReady?{pinnedEndpoint:PRODUCTION_PORTAL_ENDPOINT}:{}),
      required:['approved_operations','accept_target_risks'],
      warning:'Only source-reviewed, live-advertised read tools; exact schema is rechecked at execution. Discovery is not an execution or permission grant.'};
  }
  if(id==='action.github.run'){
    const approved=githubReady?await listAvailableGitHubActions(env):{actions:[]};
    detail.discovered_actions=approved.actions;
    if(githubReady)detail.availability=approved.actions.some(x=>x.can_publish)?
      'publishable_after_owner_approval':'no_verified_published_action';
    detail.grant={required:['approved_actions','approve_heavy_execution'],
      note:'Discovery is not approval; review exact SHA, immutable tag/ref, workflow and contract digest before Publish.'};
  }
  return detail;
}
